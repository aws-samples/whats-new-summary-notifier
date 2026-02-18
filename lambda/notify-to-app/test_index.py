# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import os
import urllib.parse
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("MODEL_ID", "test-model-id")
os.environ.setdefault("MODEL_REGION", "us-west-2")
os.environ.setdefault("NOTIFIERS", json.dumps({
    "TestNotifier": {
        "summarizerName": "AwsSolutionsArchitectJapanese",
        "webhookUrlParameterName": "/Test/URL",
    }
}))
os.environ.setdefault("SUMMARIZERS", json.dumps({
    "AwsSolutionsArchitectJapanese": {
        "outputLanguage": "Japanese.",
        "persona": "solutions architect in AWS",
    }
}))

import index  # noqa: E402


def _make_dynamodb_record(event_name, url="https://example.com", title="Test Title",
                           category="Test", pubtime="2024-01-01T00:00:00",
                           notifier_name="TestNotifier"):
    return {
        "eventName": event_name,
        "dynamodb": {
            "NewImage": {
                "url": {"S": url},
                "title": {"S": title},
                "category": {"S": category},
                "pubtime": {"S": pubtime},
                "notifier_name": {"S": notifier_name},
            }
        },
    }


class TestGetBlogContent:
    def test_invalid_url_returns_none(self):
        assert index.get_blog_content("ftp://example.com") is None

    def test_non_http_url_returns_none(self):
        assert index.get_blog_content("javascript:alert(1)") is None

    def test_valid_url_with_main_tag_returns_text(self):
        mock_response = MagicMock()
        mock_response.text = "<html><body><main>Main content here</main></body></html>"
        mock_scraper = MagicMock()
        mock_scraper.get.return_value = mock_response
        with patch("index.cloudscraper.create_scraper", return_value=mock_scraper):
            result = index.get_blog_content("https://example.com")
        assert result == "Main content here"

    def test_valid_url_without_main_tag_returns_none(self):
        mock_response = MagicMock()
        mock_response.text = "<html><body><div>No main tag</div></body></html>"
        mock_scraper = MagicMock()
        mock_scraper.get.return_value = mock_response
        with patch("index.cloudscraper.create_scraper", return_value=mock_scraper):
            result = index.get_blog_content("https://example.com")
        assert result is None

    def test_http_error_returns_none(self):
        mock_scraper = MagicMock()
        mock_scraper.get.side_effect = Exception("Connection refused")
        with patch("index.cloudscraper.create_scraper", return_value=mock_scraper):
            result = index.get_blog_content("https://example.com")
        assert result is None


class TestGetNewEntries:
    def test_insert_event_is_included(self):
        records = [_make_dynamodb_record("INSERT")]
        result = index.get_new_entries(records)
        assert len(result) == 1
        assert result[0]["rss_link"] == "https://example.com"
        assert result[0]["rss_title"] == "Test Title"
        assert result[0]["rss_notifier_name"] == "TestNotifier"

    def test_remove_event_is_skipped(self):
        records = [_make_dynamodb_record("REMOVE")]
        result = index.get_new_entries(records)
        assert result == []

    def test_modify_event_is_skipped(self):
        records = [_make_dynamodb_record("MODIFY")]
        result = index.get_new_entries(records)
        assert result == []

    def test_mixed_events_only_inserts_returned(self):
        records = [
            _make_dynamodb_record("INSERT", url="https://example.com/1"),
            _make_dynamodb_record("REMOVE", url="https://example.com/2"),
            _make_dynamodb_record("INSERT", url="https://example.com/3"),
        ]
        result = index.get_new_entries(records)
        assert len(result) == 2
        assert result[0]["rss_link"] == "https://example.com/1"
        assert result[1]["rss_link"] == "https://example.com/3"


class TestCreateSlackMessage:
    def _make_item(self, twitter="Test tweet", rss_link="https://example.com/article"):
        return {
            "rss_time": "2024-01-01T00:00:00",
            "rss_title": "Test Article",
            "rss_link": rss_link,
            "summary": "Summary text",
            "detail": "Detail text",
            "twitter": twitter,
        }

    def test_message_contains_rss_link(self):
        item = self._make_item()
        msg = index.create_slack_message(item)
        assert "https://example.com/article" in msg["text"]

    def test_twitter_text_is_url_encoded(self):
        item = self._make_item(twitter="AWS新機能 テスト")
        msg = index.create_slack_message(item)
        encoded = urllib.parse.quote("AWS新機能 テスト")
        assert encoded in msg["text"]

    def test_share_on_x_link_is_present(self):
        item = self._make_item()
        msg = index.create_slack_message(item)
        assert "Share on X" in msg["text"]
        assert "x.com/intent/tweet" in msg["text"]

    def test_rss_link_in_tweet_url_is_encoded(self):
        item = self._make_item(rss_link="https://example.com/article?foo=bar&baz=qux")
        msg = index.create_slack_message(item)
        assert "article%3Ffoo%3Dbar%26baz%3Dqux" in msg["text"] or "article" in msg["text"]


class TestPushNotificationFallback:
    def test_none_content_falls_back_to_title(self, capsys):
        item = {
            "rss_notifier_name": "TestNotifier",
            "rss_link": "https://example.com",
            "rss_title": "Fallback Title",
            "rss_time": "2024-01-01T00:00:00",
        }
        with patch("index.ssm.get_parameter", return_value={"Parameter": {"Value": "https://hooks.example.com"}}), \
             patch("index.get_blog_content", return_value=None), \
             patch("index.summarize_blog", return_value=("summary", "detail", "twitter")) as mock_summarize, \
             patch("index.urllib.request.urlopen"), \
             patch("index.time.sleep"):
            index.push_notification([item])

        mock_summarize.assert_called_once()
        call_args = mock_summarize.call_args
        assert call_args[0][0] == "Fallback Title"
        captured = capsys.readouterr()
        assert "Falling back to title only" in captured.out
