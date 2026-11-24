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


GC_ITEM = {
    "rss_title": "New <feature> | launch",
    "rss_link": "https://example.com/a",
    "summary": "Short summary.",
    "detail": "- point 1\n- point 2",
}


class TestCreateGoogleChatMessage:
    """Test Google Chat incoming webhook message creation."""

    def test_text_has_link_summary_and_detail(self):
        msg = index.create_google_chat_message(dict(GC_ITEM))
        assert list(msg) == ["text"]
        assert msg["text"] == (
            "<https://example.com/a|New ＜feature＞ ｜ launch>\nShort summary.\n\n- point 1\n- point 2"
        )

    def test_non_http_link_is_not_a_link(self):
        item = dict(GC_ITEM, rss_link="javascript:alert(1)")
        text = index.create_google_chat_message(item)["text"]
        assert not text.startswith("<")
        assert text.startswith("New ＜feature＞ ｜ launch\njavascript:alert(1)\n")


class TestPushNotificationDestination:
    """Test that push_notification formats the message for each destination."""

    def _push(self, monkeypatch, destination):
        posted = []

        class _Res:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"ok"

        def fake_urlopen(req, *a, **k):
            posted.append(json.loads(req.data))
            return _Res()

        notifier = {"destination": destination, "summarizerName": "TestSummarizer", "webhookUrlParameterName": "/p"}
        monkeypatch.setattr(index, "NOTIFIERS", {"N": notifier})
        ssm = MagicMock()
        ssm.get_parameter.return_value = {"Parameter": {"Value": "https://hooks.example.com/x"}}
        monkeypatch.setattr(index, "ssm", ssm)
        monkeypatch.setattr(index, "get_blog_content", lambda url: "body")
        monkeypatch.setattr(index, "summarize_blog", lambda *a, **k: ("sum", "- d", {"model_id": "m", "latency_sec": 1, "input_tokens": 1, "output_tokens": 1}))
        monkeypatch.setattr(index.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.setattr(index.time, "sleep", lambda s: None)
        item = {"rss_title": "T", "rss_link": "https://example.com/a", "rss_time": "t", "rss_category": "c", "rss_notifier_name": "N"}
        index.push_notification([item])
        return posted

    def test_googlechat(self, monkeypatch):
        assert self._push(monkeypatch, "googlechat") == [{"text": "<https://example.com/a|T>\nsum\n\n- d"}]

    def test_slack_is_unchanged(self, monkeypatch):
        posted = self._push(monkeypatch, "slack")
        assert posted[0]["rss_title"] == "T" and posted[0]["summary"] == "sum"

    def test_unknown_destination_falls_back_to_slack(self, monkeypatch):
        posted = self._push(monkeypatch, "other")
        assert "text" not in posted[0] and posted[0]["summary"] == "sum"


class TestModelIds:
    """Test model IDs configuration."""

    def test_model_ids_loaded_as_list(self):
        assert isinstance(index.MODEL_IDS, list)
        assert len(index.MODEL_IDS) == 2
        assert index.MODEL_IDS[0] == "model-a"
        assert index.MODEL_IDS[1] == "model-b"


class _FakeClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class TestSummarizeBlog:
    """Test summarize_blog response parsing and model fallback."""

    OUTPUT = "<output><detail>- point\\n</detail><summary>short summary</summary></output>"

    def _run(self, monkeypatch, responses):
        client = MagicMock()
        client.converse.side_effect = responses
        monkeypatch.setattr(index, "get_bedrock_client", lambda **_: client)
        monkeypatch.setattr(index, "ClientError", _FakeClientError)
        return index.summarize_blog("body", "English.", "engineer"), client

    @staticmethod
    def _response(content, stop_reason="end_turn"):
        return {"output": {"message": {"content": content}}, "stopReason": stop_reason, "usage": {}}

    def test_skips_reasoning_block(self, monkeypatch):
        reasoning = {"reasoningContent": {"reasoningText": {"text": "", "signature": "x"}}}
        (summary, detail, metrics), _ = self._run(
            monkeypatch, [self._response([reasoning, {"text": self.OUTPUT}])]
        )
        assert summary == "short summary"
        assert detail == "- point"
        assert metrics["model_id"] == "model-a"

    def test_falls_back_when_output_is_empty(self, monkeypatch):
        (summary, _, metrics), client = self._run(
            monkeypatch,
            [self._response([], "content_filtered"), self._response([{"text": self.OUTPUT}])],
        )
        assert summary == "short summary"
        assert metrics["model_id"] == "model-b"
        assert client.converse.call_count == 2

    def test_falls_back_on_validation_error(self, monkeypatch):
        (_, _, metrics), _ = self._run(
            monkeypatch,
            [_FakeClientError("ValidationException"), self._response([{"text": self.OUTPUT}])],
        )
        assert metrics["model_id"] == "model-b"

    def test_does_not_send_temperature(self, monkeypatch):
        _, client = self._run(monkeypatch, [self._response([{"text": self.OUTPUT}])])
        assert "temperature" not in client.converse.call_args.kwargs["inferenceConfig"]


class TestCleanDetail:
    """Test clean_detail removes artifacts that render badly in Slack."""

    def test_removes_literal_newlines_markdown_and_headings(self):
        raw = (
            "\n- **新機能について：**\n"
            "- UIが利用可能になりました。\\n\n"
            "- **CloudTrail** で記録されます。\\n\n"
            "\n- **対象ユーザーについて：**\n"
            "- 運用チームに適しています。\\n\n"
        )
        assert index.clean_detail(raw) == (
            "- UIが利用可能になりました。\n- CloudTrail で記録されます。\n- 運用チームに適しています。"
        )

    def test_keeps_plain_bullets(self):
        assert index.clean_detail("- a\n- b") == "- a\n- b"
