"""Tests for rss-crawler Lambda function."""

import importlib.util
import os
import sys
from unittest.mock import MagicMock

os.environ.setdefault("DDB_TABLE_NAME", "test-table")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
# feedparser is not needed by the functions under test and is not installed in CI
sys.modules.setdefault("feedparser", MagicMock())

# Load under its own name: notify-to-app's tests also import a module named "index"
_spec = importlib.util.spec_from_file_location("wnsn_crawler", os.path.join(os.path.dirname(__file__), "index.py"))
crawler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(crawler)


def _put_items(monkeypatch):
    table = MagicMock()
    monkeypatch.setattr(crawler, "table", table)
    return table


class TestWriteToTable:
    def test_stores_description(self, monkeypatch):
        table = _put_items(monkeypatch)
        crawler.write_to_table("https://e/a", "T", "c", "2026-11-24T00:00:00", "N", "<p>desc</p>")
        assert table.put_item.call_args.kwargs["Item"]["rss_description"] == "<p>desc</p>"

    def test_truncates_description(self, monkeypatch):
        table = _put_items(monkeypatch)
        crawler.write_to_table("https://e/a", "T", "c", "t", "N", "a" * (crawler.MAX_DESCRIPTION_CHARS + 10))
        assert len(table.put_item.call_args.kwargs["Item"]["rss_description"]) == crawler.MAX_DESCRIPTION_CHARS

    def test_item_unchanged_without_description(self, monkeypatch):
        table = _put_items(monkeypatch)
        crawler.write_to_table("https://e/a", "T", "c", "t", "N")
        assert table.put_item.call_args.kwargs["Item"] == {
            "url": "https://e/a",
            "notifier_name": "N",
            "title": "T",
            "category": "c",
            "pubtime": "t",
        }


class TestAddBlog:
    def test_passes_entry_summary(self, monkeypatch):
        table = _put_items(monkeypatch)
        monkeypatch.setattr(crawler, "recently_published", lambda pub: True)
        entry = {"link": "https://e/a", "title": "T", "published": "Tue, 24 Nov 2026 00:00:00 GMT", "summary": "<p>d</p>"}
        crawler.add_blog("What's new", [entry], "N")
        assert table.put_item.call_args.kwargs["Item"]["rss_description"] == "<p>d</p>"
