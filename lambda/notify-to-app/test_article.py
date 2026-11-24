"""Tests for article fetching: URL checks, limits and text extraction."""

import email.message
import importlib.util
import io
import os
import socket
import sys
import urllib.error
from unittest.mock import MagicMock

import pytest

# test_index.py replaces bs4 with a mock in sys.modules for the whole test
# process, and bs4 imports itself at run time. Load this module under its own
# name with the real bs4, and put the real bs4 back for every test here.
if isinstance(sys.modules.get("bs4"), MagicMock):
    del sys.modules["bs4"]
import bs4

REAL_BS4 = bs4
_spec = importlib.util.spec_from_file_location("wnsn_article", os.path.join(os.path.dirname(__file__), "article.py"))
article = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(article)


@pytest.fixture(autouse=True)
def _real_bs4(monkeypatch):
    monkeypatch.setitem(sys.modules, "bs4", REAL_BS4)


def _resolve_to(monkeypatch, mapping):
    """Make socket.getaddrinfo return the given address for each host."""

    def fake_getaddrinfo(host, port, *args, **kwargs):
        if host not in mapping:
            raise socket.gaierror("unknown host")
        return [(socket.AF_INET6 if ":" in a else socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, port)) for a in mapping[host]]

    monkeypatch.setattr(article.socket, "getaddrinfo", fake_getaddrinfo)


class TestCheckUrl:
    @pytest.mark.parametrize(
        "addr",
        # addresses that check_url must reject; nothing binds to them
        ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"],  # nosec B104
    )
    def test_rejects_non_public_address(self, monkeypatch, addr):
        _resolve_to(monkeypatch, {"evil.example": [addr]})
        with pytest.raises(article.UnsafeURLError):
            article.check_url("https://evil.example/a")

    def test_rejects_when_any_address_is_private(self, monkeypatch):
        _resolve_to(monkeypatch, {"mixed.example": ["93.184.215.14", "10.0.0.1"]})
        with pytest.raises(article.UnsafeURLError):
            article.check_url("https://mixed.example/a")

    @pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/a", "gopher://example.com/", "https:///nohost", "http://example.com:99999/"])
    def test_rejects_bad_url(self, monkeypatch, url):
        _resolve_to(monkeypatch, {"example.com": ["93.184.215.14"]})
        with pytest.raises(article.UnsafeURLError):
            article.check_url(url)

    def test_rejects_unresolvable_host(self, monkeypatch):
        _resolve_to(monkeypatch, {})
        with pytest.raises(article.UnsafeURLError):
            article.check_url("https://nowhere.example/")

    def test_accepts_public_address(self, monkeypatch):
        _resolve_to(monkeypatch, {"example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]})
        article.check_url("https://example.com/a")


class TestRedirect:
    def _redirect(self, newurl):
        handler = article._CheckedRedirectHandler()
        req = article.urllib.request.Request("https://example.com/a")
        fp = MagicMock()
        return handler.redirect_request(req, fp, 302, "Found", email.message.Message(), newurl), fp

    def test_rejects_redirect_to_private_address(self, monkeypatch):
        _resolve_to(monkeypatch, {"internal.example": ["169.254.169.254"]})
        with pytest.raises(article.UnsafeURLError):
            self._redirect("http://internal.example/latest/meta-data/")

    def test_rejects_redirect_to_other_scheme(self, monkeypatch):
        with pytest.raises(article.UnsafeURLError):
            self._redirect("ftp://example.com/file")

    def test_follows_redirect_to_public_address(self, monkeypatch):
        _resolve_to(monkeypatch, {"www.example.com": ["93.184.215.14"]})
        new_req, _ = self._redirect("https://www.example.com/b")
        assert new_req.full_url == "https://www.example.com/b"

    def test_redirect_limit(self):
        assert article._CheckedRedirectHandler.max_redirections == 5


class _FakeResponse:
    def __init__(self, body, content_type="text/html; charset=utf-8", length=None, chunk_size=64 * 1024):
        self.headers = email.message.Message()
        self.headers["Content-Type"] = content_type
        if length is not None:
            self.headers["Content-Length"] = str(length)
        self._body = io.BytesIO(body)
        self._chunk = chunk_size

    def read(self, n=-1):
        return self._body.read(min(n, self._chunk) if n and n > 0 else self._chunk)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeOpener:
    def __init__(self, response=None, error=None):
        self.response, self.error, self.requests = response, error, []

    def open(self, req, timeout=None):
        self.requests.append((req, timeout))
        if self.error:
            raise self.error
        return self.response


class TestFetchHtml:
    @pytest.fixture(autouse=True)
    def _public(self, monkeypatch):
        _resolve_to(monkeypatch, {"example.com": ["93.184.215.14"], "internal.example": ["10.0.0.5"]})

    def test_sends_user_agent_and_timeout(self):
        opener = _FakeOpener(_FakeResponse(b"<html></html>"))
        body, charset = article.fetch_html("https://example.com/a", opener=opener)
        req, timeout = opener.requests[0]
        assert body == b"<html></html>" and charset == "utf-8"
        assert req.get_header("User-agent") == article.USER_AGENT
        assert timeout == article.TIMEOUT_SEC

    def test_checks_url_before_request(self):
        opener = _FakeOpener(_FakeResponse(b"x"))
        with pytest.raises(article.UnsafeURLError):
            article.fetch_html("http://internal.example/", opener=opener)
        assert opener.requests == []

    def test_rejects_large_content_length(self):
        opener = _FakeOpener(_FakeResponse(b"", length=article.MAX_BYTES + 1))
        with pytest.raises(article.FetchError, match="larger"):
            article.fetch_html("https://example.com/a", opener=opener)

    def test_stops_reading_past_size_limit(self):
        opener = _FakeOpener(_FakeResponse(b"a" * (article.MAX_BYTES + 10)))
        with pytest.raises(article.FetchError, match="larger"):
            article.fetch_html("https://example.com/a", opener=opener)

    def test_rejects_non_html(self):
        opener = _FakeOpener(_FakeResponse(b"%PDF", content_type="application/pdf"))
        with pytest.raises(article.FetchError, match="not an HTML"):
            article.fetch_html("https://example.com/a", opener=opener)

    def test_stops_after_deadline(self):
        ticks = iter([0, 5, article.DEADLINE_SEC + 1])
        opener = _FakeOpener(_FakeResponse(b"a" * 200, chunk_size=100))
        with pytest.raises(article.FetchError, match="longer than"):
            article.fetch_html("https://example.com/a", opener=opener, clock=lambda: next(ticks))

    def test_timeout_becomes_fetch_error(self):
        opener = _FakeOpener(error=urllib.error.URLError(TimeoutError("timed out")))
        with pytest.raises(article.FetchError):
            article.fetch_html("https://example.com/a", opener=opener)

    def test_http_error_becomes_fetch_error(self):
        err = urllib.error.HTTPError("https://example.com/a", 403, "Forbidden", email.message.Message(), io.BytesIO(b""))
        with pytest.raises(article.FetchError, match="HTTP 403"):
            article.fetch_html("https://example.com/a", opener=_FakeOpener(error=err))


class TestExtractText:
    def test_prefers_main(self):
        html = "<body><nav>menu</nav><main><h1>Title</h1><p>Body text</p><script>x()</script></main><article>other</article></body>"
        assert article.extract_text(html) == "Title\nBody text"

    def test_falls_back_to_article(self):
        html = "<body><header>site</header><article><p>Article text</p><aside>ad</aside></article></body>"
        assert article.extract_text(html) == "Article text"

    def test_falls_back_to_body_without_page_chrome(self):
        html = "<html><body><header>Site</header><nav>Menu</nav><div><p>Line one</p>\n<p>Line   two</p></div><footer>(c)</footer><style>p{}</style></body></html>"
        assert article.extract_text(html) == "Line one\nLine two"

    def test_none_without_text(self):
        assert article.extract_text("<html><body><script>x()</script></body></html>") is None

    def test_truncates_long_text(self):
        html = "<main><p>" + "a" * (article.MAX_CHARS + 100) + "</p></main>"
        assert len(article.extract_text(html)) == article.MAX_CHARS

    def test_reads_bytes_with_charset(self):
        html = "<main><p>日本語の本文</p></main>".encode("shift_jis")
        assert article.extract_text(html, "shift_jis") == "日本語の本文"


class TestDescriptionText:
    def test_strips_html(self):
        assert article.description_text("<p>One <b>bold</b> line.</p><p>Two.</p>") == "One bold line.\nTwo."

    def test_empty(self):
        assert article.description_text("") == ""


class TestGetArticleText:
    def test_reason_when_fetch_fails(self, monkeypatch):
        monkeypatch.setattr(article, "fetch_html", MagicMock(side_effect=article.FetchError("HTTP 403")))
        assert article.get_article_text("https://example.com/a") == (None, "HTTP 403")

    def test_reason_when_no_text(self, monkeypatch):
        monkeypatch.setattr(article, "fetch_html", lambda url: (b"<html><body></body></html>", None))
        text, reason = article.get_article_text("https://example.com/a")
        assert text is None and "no text" in reason
