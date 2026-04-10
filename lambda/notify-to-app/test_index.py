"""Tests for notify-to-app Lambda function."""

import json
import os
import sys
from unittest.mock import MagicMock

# Set env vars before importing the module
os.environ["MODEL_IDS"] = json.dumps(["model-a", "model-b"])
os.environ["MODEL_REGION"] = "us-east-1"
os.environ["DDB_TABLE_NAME"] = "test-table"
os.environ["NOTIFIERS"] = json.dumps(
    {
        "TestNotifier": {
            "destination": "slack",
            "summarizerName": "TestSummarizer",
            "webhookUrlParameterName": "/test/url",
            "rssUrl": {"feed": "https://example.com/feed"},
        }
    }
)
os.environ["SUMMARIZERS"] = json.dumps(
    {"TestSummarizer": {"outputLanguage": "English.", "persona": "engineer"}}
)

# Mock boto3 before import
sys.modules["boto3"] = MagicMock()
sys.modules["botocore"] = MagicMock()
sys.modules["botocore.config"] = MagicMock()
sys.modules["botocore.exceptions"] = MagicMock()
sys.modules["bs4"] = MagicMock()

# Now import
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lambda", "notify-to-app"))
import index


class TestGetNewEntries:
    """Test get_new_entries filters DynamoDB stream events."""

    def test_insert_event_extracted(self):
        records = [
            {
                "eventName": "INSERT",
                "dynamodb": {
                    "NewImage": {
                        "category": {"S": "What's new"},
                        "pubtime": {"S": "2024-01-01T00:00:00"},
                        "title": {"S": "Test Article"},
                        "url": {"S": "https://example.com/article"},
                        "notifier_name": {"S": "TestNotifier"},
                    }
                },
            }
        ]
        result = index.get_new_entries(records)
        assert len(result) == 1
        assert result[0]["rss_title"] == "Test Article"
        assert result[0]["rss_link"] == "https://example.com/article"
        assert result[0]["rss_notifier_name"] == "TestNotifier"

    def test_update_event_skipped(self):
        records = [{"eventName": "MODIFY", "dynamodb": {}}]
        result = index.get_new_entries(records)
        assert len(result) == 0

    def test_remove_event_skipped(self):
        records = [{"eventName": "REMOVE", "dynamodb": {}}]
        result = index.get_new_entries(records)
        assert len(result) == 0

    def test_mixed_events(self):
        records = [
            {
                "eventName": "INSERT",
                "dynamodb": {
                    "NewImage": {
                        "category": {"S": "News"},
                        "pubtime": {"S": "2024-01-01T00:00:00"},
                        "title": {"S": "Article 1"},
                        "url": {"S": "https://example.com/1"},
                        "notifier_name": {"S": "N1"},
                    }
                },
            },
            {"eventName": "MODIFY", "dynamodb": {}},
            {"eventName": "REMOVE", "dynamodb": {}},
        ]
        result = index.get_new_entries(records)
        assert len(result) == 1


class TestGetBlogContent:
    """Test get_blog_content URL validation."""

    def test_rejects_non_http_url(self):
        result = index.get_blog_content("file:///etc/passwd")
        assert result is None

    def test_rejects_ftp_url(self):
        result = index.get_blog_content("ftp://example.com/file")
        assert result is None


class TestCreateTeamsMessage:
    """Test Teams adaptive card message creation."""

    def test_message_structure(self):
        item = {
            "rss_title": "Test Title",
            "rss_link": "https://example.com",
            "summary": "Test summary",
            "detail": "- detail 1\n- detail 2",
        }
        msg = index.create_teams_message(item)
        assert msg["type"] == "message"
        assert len(msg["attachments"]) == 1
        card = msg["attachments"][0]["content"]
        assert card["type"] == "AdaptiveCard"
        # Check action URL
        assert card["actions"][0]["url"] == "https://example.com"


class TestModelIds:
    """Test model IDs configuration."""

    def test_model_ids_loaded_as_list(self):
        assert isinstance(index.MODEL_IDS, list)
        assert len(index.MODEL_IDS) == 2
        assert index.MODEL_IDS[0] == "model-a"
        assert index.MODEL_IDS[1] == "model-b"
