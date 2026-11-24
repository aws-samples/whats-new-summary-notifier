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
