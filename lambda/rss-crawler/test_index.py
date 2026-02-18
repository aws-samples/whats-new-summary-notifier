# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import datetime
import os
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

os.environ.setdefault("DDB_TABLE_NAME", "test-table")

import index  # noqa: E402


class TestRecentlyPublished:
    def test_within_7_days_returns_true(self):
        recent = (datetime.datetime.now() - datetime.timedelta(days=3)).strftime(
            "%a, %d %b %Y %H:%M:%S +0000"
        )
        assert index.recently_published(recent) is True

    def test_exactly_7_days_returns_true(self):
        exactly_7 = (datetime.datetime.now() - datetime.timedelta(days=7)).strftime(
            "%a, %d %b %Y %H:%M:%S +0000"
        )
        assert index.recently_published(exactly_7) is True

    def test_older_than_7_days_returns_false(self):
        old = (datetime.datetime.now() - datetime.timedelta(days=8)).strftime(
            "%a, %d %b %Y %H:%M:%S +0000"
        )
        assert index.recently_published(old) is False


class TestStr2Datetime:
    def test_rss_date_string_parses_correctly(self):
        result = index.str2datetime("Tue, 20 Sep 2022 16:05:47 +0000")
        assert result == datetime.datetime(2022, 9, 20, 16, 5, 47)

    def test_timezone_is_ignored(self):
        result_utc = index.str2datetime("Tue, 20 Sep 2022 16:05:47 +0000")
        result_jst = index.str2datetime("Tue, 20 Sep 2022 16:05:47 +0900")
        assert result_utc == result_jst


class TestWriteToTable:
    def test_successful_write_calls_put_item(self):
        with patch.object(index.table, "put_item") as mock_put:
            index.write_to_table("https://example.com", "Title", "Category", "2024-01-01T00:00:00", "TestNotifier")
            mock_put.assert_called_once()

    def test_client_error_is_logged_and_not_raised(self, capsys):
        error_response = {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "Throughput exceeded"}}
        with patch.object(index.table, "put_item", side_effect=ClientError(error_response, "PutItem")):
            index.write_to_table("https://example.com", "Title", "Category", "2024-01-01T00:00:00", "TestNotifier")
        captured = capsys.readouterr()
        assert "DynamoDB error writing Title" in captured.out


class TestHandler:
    def test_handler_reads_explicit_keys_from_event(self):
        event = {
            "notifierName": "AwsWhatsNew",
            "notifier": {
                "rssUrl": {"TestFeed": "https://example.com/feed"}
            },
        }
        mock_result = {
            "feed": {"updated": (datetime.datetime.now() - datetime.timedelta(days=8)).strftime("%a, %d %b %Y %H:%M:%S +0000")},
            "entries": [],
        }
        with patch("index.feedparser.parse", return_value=mock_result), \
             patch("index.json.dumps", return_value="{}"):
            index.handler(event, None)

    def test_handler_raises_on_missing_key(self):
        event = {"wrongKey": "value"}
        with pytest.raises(KeyError):
            index.handler(event, None)
