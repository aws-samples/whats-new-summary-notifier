"""Tests for rss-crawler Lambda function."""

import importlib.util
import os
import sys
from typing import ClassVar
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("DDB_TABLE_NAME", "test-table")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
# feedparser is not needed by the functions under test and is not installed in CI
sys.modules.setdefault("feedparser", MagicMock())

# Load under its own name: notify-to-app's tests also import a module named "index"
_spec = importlib.util.spec_from_file_location("wnsn_crawler", os.path.join(os.path.dirname(__file__), "index.py"))
crawler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(crawler)

# A real What's New entry keeps all its tags in one comma-separated term
WHATS_NEW_TAGS = [
    {
        "term": "marketing:marchitecture/artificial-intelligence,general:products/amazon-bedrock,general:products/amazon-bedrock-agentcore",
        "scheme": None,
        "label": None,
    }
]


def _entry(tags=None):
    entry = {"link": "https://e/a", "title": "T", "published": "Tue, 24 Nov 2026 00:00:00 GMT"}
    if tags is not None:
        entry["tags"] = tags
    return entry


def _items(monkeypatch, entries, categories):
    table = MagicMock()
    monkeypatch.setattr(crawler, "table", table)
    monkeypatch.setattr(crawler, "recently_published", lambda pub: True)
    crawler.add_blog("What's new", entries, "N", categories)
    return [c.kwargs["Item"] for c in table.put_item.call_args_list]


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


class TestFilterCategories:
    def test_no_filter(self):
        assert crawler.filter_categories({"destination": "slack"}) == []

    def test_empty_filter(self):
        assert crawler.filter_categories({"filter": {}}) == []

    def test_normalizes(self):
        assert crawler.filter_categories({"filter": {"categories": [" General:Products/Amazon-Bedrock ", ""]}}) == [
            "general:products/amazon-bedrock"
        ]

    def test_invalid_is_ignored(self):
        assert crawler.filter_categories({"filter": {"categories": "general:products"}}) == []
        assert crawler.filter_categories({"filter": ["general:products"]}) == []


class TestEntryTags:
    def test_splits_comma_separated_terms(self):
        assert crawler.entry_tags(_entry(WHATS_NEW_TAGS)) == [
            "marketing:marchitecture/artificial-intelligence",
            "general:products/amazon-bedrock",
            "general:products/amazon-bedrock-agentcore",
        ]

    def test_no_tags(self):
        assert crawler.entry_tags(_entry()) == []


MATCH_TAGS = ["general:products/amazon-bedrock", "marketing:marchitecture/artificial-intelligence"]


class TestMatchesCategories:
    def test_exact(self):
        assert crawler.matches_categories(MATCH_TAGS, ["general:products/amazon-bedrock"])

    def test_prefix_at_slash(self):
        assert crawler.matches_categories(MATCH_TAGS, ["general:products"])

    def test_prefix_without_slash_does_not_match(self):
        assert not crawler.matches_categories(MATCH_TAGS, ["general:products/amazon-bed"])

    def test_no_match(self):
        assert not crawler.matches_categories(MATCH_TAGS, ["general:products/amazon-s3"])

    def test_no_categories_or_no_tags_passes(self):
        assert crawler.matches_categories(MATCH_TAGS, [])
        assert crawler.matches_categories([], ["general:products/amazon-s3"])


class TestAddBlog:
    def test_without_filter_items_are_unchanged(self, monkeypatch):
        items = _items(monkeypatch, [_entry(WHATS_NEW_TAGS)], [])
        assert items == [{"url": "https://e/a", "notifier_name": "N", "title": "T", "category": "What's new",
                          "pubtime": "2026-11-24T00:00:00"}]

    def test_matching_entry_is_not_marked(self, monkeypatch):
        items = _items(monkeypatch, [_entry(WHATS_NEW_TAGS)], ["general:products/amazon-bedrock"])
        assert "filter_result" not in items[0]

    def test_excluded_entry_is_written_with_a_mark(self, monkeypatch):
        items = _items(monkeypatch, [_entry(WHATS_NEW_TAGS)], ["general:products/amazon-s3"])
        assert items[0]["filter_result"] == "excluded:categories"

    def test_entry_without_tags_passes(self, monkeypatch):
        items = _items(monkeypatch, [_entry()], ["general:products/amazon-s3"])
        assert "filter_result" not in items[0]

    def test_passes_entry_summary(self, monkeypatch):
        table = _put_items(monkeypatch)
        monkeypatch.setattr(crawler, "recently_published", lambda pub: True)
        entry = {"link": "https://e/a", "title": "T", "published": "Tue, 24 Nov 2026 00:00:00 GMT", "summary": "<p>d</p>"}
        crawler.add_blog("What's new", [entry], "N")
        assert table.put_item.call_args.kwargs["Item"]["rss_description"] == "<p>d</p>"

    def test_excluded_entry_keeps_its_description(self, monkeypatch):
        entry = {**_entry(WHATS_NEW_TAGS), "summary": "<p>d</p>"}
        items = _items(monkeypatch, [entry], ["general:products/amazon-s3"])
        assert items[0]["filter_result"] == "excluded:categories"
        assert items[0]["rss_description"] == "<p>d</p>"


class _FakeClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class _ConditionalTable:
    """A table that applies the crawler's "does not exist yet" condition like DynamoDB does

    The table key is (url, notifier_name), so attribute_not_exists(url) fails only when an
    item with the same url and notifier_name exists.
    """

    def __init__(self, items):
        self.items = {(i["url"], i["notifier_name"]): dict(i) for i in items}

    def put_item(self, Item, ConditionExpression=None, ExpressionAttributeNames=None):
        key = (Item["url"], Item["notifier_name"])
        conditional = ConditionExpression == "attribute_not_exists(#url)" and ExpressionAttributeNames == {"#url": "url"}
        if conditional and key in self.items:
            raise _FakeClientError("ConditionalCheckFailedException")
        self.items[key] = dict(Item)


class TestConditionalWrite:
    SUMMARIZED: ClassVar[dict] = {
        "url": "https://e/a", "notifier_name": "N", "title": "T", "category": "What's new",
        "pubtime": "2026-11-24T00:00:00", "summary": "sum", "detail": "- d", "summary_status": "completed",
    }
    FILTERED: ClassVar[dict] = {
        "url": "https://e/b", "notifier_name": "N", "title": "B", "category": "What's new",
        "pubtime": "2026-11-24T00:00:00", "summary_status": "filtered",
    }

    def _crawl(self, monkeypatch, existing, entries, categories):
        table = _ConditionalTable(existing)
        monkeypatch.setattr(crawler, "table", table)
        monkeypatch.setattr(crawler, "ClientError", _FakeClientError)
        monkeypatch.setattr(crawler, "recently_published", lambda pub: True)
        crawler.add_blog("What's new", entries, "N", categories)
        return table.items

    def test_put_item_is_conditional(self, monkeypatch):
        table = _put_items(monkeypatch)
        crawler.write_to_table("https://e/a", "T", "c", "t", "N", "<p>d</p>", filter_result="excluded:categories")
        kwargs = table.put_item.call_args.kwargs
        assert kwargs["ConditionExpression"] == "attribute_not_exists(#url)"
        assert kwargs["ExpressionAttributeNames"] == {"#url": "url"}

    def test_new_post_is_written_with_description_and_filter_result(self, monkeypatch):
        entry = {**_entry(WHATS_NEW_TAGS), "link": "https://e/new", "summary": "<p>d</p>"}
        items = self._crawl(monkeypatch, [], [entry], ["general:products/amazon-s3"])
        new = items[("https://e/new", "N")]
        assert new["rss_description"] == "<p>d</p>"
        assert new["filter_result"] == "excluded:categories"

    def test_recrawl_keeps_the_summary_and_the_filtered_status(self, monkeypatch):
        entries = [
            {**_entry(WHATS_NEW_TAGS), "link": "https://e/a", "summary": "<p>d</p>"},
            {**_entry(WHATS_NEW_TAGS), "link": "https://e/b", "summary": "<p>d</p>"},
        ]
        items = self._crawl(monkeypatch, [self.SUMMARIZED, self.FILTERED], entries, ["general:products/amazon-s3"])
        assert items[("https://e/a", "N")] == self.SUMMARIZED
        assert items[("https://e/b", "N")] == self.FILTERED

    def test_same_url_for_another_notifier_is_still_written(self, monkeypatch):
        items = self._crawl(monkeypatch, [{**self.SUMMARIZED, "notifier_name": "Other"}], [_entry()], [])
        assert items[("https://e/a", "N")]["title"] == "T"
        assert items[("https://e/a", "Other")]["summary"] == "sum"


class TestCrawlFailures:
    """A crawl that cannot read a feed or write a post fails, after crawling the other feeds"""

    FEED_OK: ClassVar[dict] = {"feed": {"updated": "Tue, 24 Nov 2026 00:00:00 GMT"}, "entries": [_entry()]}

    def _run(self, monkeypatch, results, table=None):
        monkeypatch.setattr(crawler, "feedparser", MagicMock(parse=lambda url: results[url]))
        monkeypatch.setattr(crawler, "recently_published", lambda pub: True)
        monkeypatch.setattr(crawler, "ClientError", _FakeClientError)
        table = table or MagicMock()
        monkeypatch.setattr(crawler, "table", table)
        notifier = {"rssUrl": {name: name for name in results}}
        crawler.handler({"notifierName": "N", "notifier": notifier}, None)
        return table

    def test_a_feed_that_cannot_be_fetched_fails_the_crawl(self, monkeypatch):
        broken = {"bozo": True, "bozo_exception": OSError("connection refused"), "feed": {}, "entries": []}
        with pytest.raises(crawler.CrawlError, match="1 RSS feed\\(s\\) of N failed: broken"):
            self._run(monkeypatch, {"broken": broken})

    def test_a_feed_without_an_updated_date_fails_the_crawl(self, monkeypatch):
        with pytest.raises(crawler.CrawlError, match="nodate"):
            self._run(monkeypatch, {"nodate": {"feed": {}, "entries": [_entry()]}})

    def test_a_readable_feed_with_bozo_set_is_still_crawled(self, monkeypatch):
        # bozo is also set for feeds that parse, for example after a character encoding override
        feed = {**self.FEED_OK, "bozo": True, "bozo_exception": ValueError("encoding overridden")}
        table = self._run(monkeypatch, {"ok": feed})
        assert table.put_item.call_count == 1

    def test_one_broken_feed_does_not_stop_the_others(self, monkeypatch):
        broken = {"bozo": True, "bozo_exception": OSError("timed out"), "feed": {}, "entries": []}
        table = MagicMock()
        with pytest.raises(crawler.CrawlError, match="broken"):
            self._run(monkeypatch, {"broken": broken, "ok": self.FEED_OK}, table)
        assert table.put_item.call_count == 1

    def test_a_write_error_fails_the_crawl(self, monkeypatch):
        table = MagicMock()
        table.put_item.side_effect = _FakeClientError("ProvisionedThroughputExceededException")
        with pytest.raises(crawler.CrawlError, match="ok"):
            self._run(monkeypatch, {"ok": self.FEED_OK}, table)

    def test_duplicates_do_not_fail_the_crawl(self, monkeypatch):
        table = MagicMock()
        table.put_item.side_effect = _FakeClientError("ConditionalCheckFailedException")
        self._run(monkeypatch, {"ok": self.FEED_OK}, table)
        assert table.put_item.call_count == 1
