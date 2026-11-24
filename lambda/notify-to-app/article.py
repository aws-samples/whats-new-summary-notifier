# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Fetch an article page and extract its text for summarization.

The article URL comes from the RSS feed, so the feed publisher, not the
operator, decides where the request goes. Every request (and every
redirect) must point to a public http(s) address, and the response is
limited in time and size.
"""

import ipaddress
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from bs4 import BeautifulSoup

USER_AGENT = "whats-new-summary-notifier (+https://github.com/aws-samples/whats-new-summary-notifier)"
TIMEOUT_SEC = 10  # per connect and per read
DEADLINE_SEC = 20  # whole download
MAX_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 5
HTML_TYPES = ("text/html", "application/xhtml+xml")
MIN_CHARS = 200  # shorter page text falls back to the RSS description
MAX_CHARS = 50000  # text passed to the model
DROP_TAGS = ["script", "style", "noscript", "template", "nav", "header", "footer", "aside", "form"]


class FetchError(Exception):
    """The article could not be fetched or used."""


class UnsafeURLError(FetchError):
    """The URL does not point to a public http(s) address."""


def _is_public(addr):
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not (addr.is_multicast or addr.is_reserved or addr.is_unspecified)


def check_url(url):
    """Raise UnsafeURLError unless url is http(s) and its host resolves only to public addresses.

    shortcut: the name is resolved again when urllib connects, so a DNS rebinding
    between the check and the connection is not caught. The Lambda runs outside a
    VPC, so the only non-public listener it can reach is the Lambda runtime API on
    loopback; pin the resolved address in the connection if that changes.
    """
    parts = urllib.parse.urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise UnsafeURLError(f"unsupported URL scheme {scheme!r}")
    host = parts.hostname
    if not host:
        raise UnsafeURLError("no host in URL")
    try:
        port = parts.port or (443 if scheme == "https" else 80)
    except ValueError as e:
        raise UnsafeURLError(f"invalid port: {e}") from e
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as e:
        raise UnsafeURLError(f"cannot resolve {host}: {e}") from e
    if not infos:
        raise UnsafeURLError(f"cannot resolve {host}")
    for info in infos:
        addr = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if not _is_public(addr):
            raise UnsafeURLError(f"{host} resolves to a non-public address {addr}")


class _CheckedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow at most MAX_REDIRECTS redirects, checking each target like the first URL."""

    max_redirections = MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            check_url(newurl)
        except UnsafeURLError:
            fp.close()
            raise
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_CheckedRedirectHandler)


def fetch_html(url, opener=None, clock=time.monotonic):
    """Download an HTML page.

    Returns:
        tuple: (body bytes, charset from Content-Type or None)

    Raises:
        FetchError: unsafe URL, HTTP error, not HTML, too large or too slow
    """
    check_url(url)
    # check_url() above allows only http(s) to public addresses, and the redirect handler checks every hop
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": ", ".join(HTML_TYPES)})  # nosec B310 # nosemgrep: dynamic-urllib-use-detected
    deadline = clock() + DEADLINE_SEC
    try:
        with (opener or _OPENER).open(request, timeout=TIMEOUT_SEC) as res:  # nosec B310 # nosemgrep: dynamic-urllib-use-detected
            content_type = res.headers.get_content_type()
            if content_type not in HTML_TYPES:
                raise FetchError(f"not an HTML page ({content_type})")
            length = res.headers.get("Content-Length")
            if length and length.isdigit() and int(length) > MAX_BYTES:
                raise FetchError(f"page is larger than {MAX_BYTES} bytes")
            chunks, total = [], 0
            while True:
                if clock() > deadline:
                    raise FetchError(f"download took longer than {DEADLINE_SEC} seconds")
                chunk = res.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_BYTES:
                    raise FetchError(f"page is larger than {MAX_BYTES} bytes")
                chunks.append(chunk)
            return b"".join(chunks), res.headers.get_content_charset()
    except FetchError:
        raise
    except urllib.error.HTTPError as e:
        e.close()
        raise FetchError(f"HTTP {e.code}") from e
    except urllib.error.URLError as e:
        raise FetchError(f"cannot access the page: {e.reason}") from e
    except (TimeoutError, OSError, ValueError) as e:
        raise FetchError(f"cannot access the page: {e}") from e


BLOCK_TAGS = ["p", "div", "li", "br", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "dt", "dd", "section"]


def _node_text(node):
    """Return the text of node, one line per block element, with spaces collapsed."""
    for tag in node.find_all(BLOCK_TAGS):
        tag.insert_after("\n")
    lines = (" ".join(line.split()) for line in node.get_text().splitlines())
    return "\n".join(line for line in lines if line)[:MAX_CHARS]


def extract_text(html, encoding=None):
    """Return the text of <main>, else <article>, else <body>, or None if none has text."""
    soup = BeautifulSoup(html, "html.parser", from_encoding=encoding) if isinstance(html, bytes) else BeautifulSoup(html, "html.parser")
    for name in ("main", "article", "body"):
        node = soup.find(name)
        if node is None:
            continue
        for tag in node.find_all(DROP_TAGS):
            tag.decompose()
        text = _node_text(node)
        if text:
            return text
    return None


def description_text(description):
    """Return the RSS description without HTML tags."""
    if not description:
        return ""
    return _node_text(BeautifulSoup(description, "html.parser"))


def get_article_text(url):
    """Fetch the article and return (text, reason). text is None when nothing could be extracted."""
    try:
        html, encoding = fetch_html(url)
    except FetchError as e:
        return None, str(e)
    text = extract_text(html, encoding)
    if text is None:
        return None, "no text in <main>, <article> or <body>"
    return text, ""
