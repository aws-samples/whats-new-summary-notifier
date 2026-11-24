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


class TestNotifierFilter:
    def test_not_set(self):
        assert index.notifier_filter({"destination": "slack"}, "topics") == []

    def test_values(self):
        assert index.notifier_filter({"filter": {"topics": ["a", " ", "b"]}}, "topics") == ["a", "b"]

    def test_invalid_is_ignored(self):
        assert index.notifier_filter({"filter": {"topics": "a"}}, "topics") == []
        assert index.notifier_filter({"filter": "a"}, "topics") == []


class TestJudgeRelevance:
    @staticmethod
    def _response(text):
        return {"output": {"message": {"content": [{"text": text}]}}, "usage": {}}

    def _run(self, monkeypatch, responses):
        client = MagicMock()
        client.converse.side_effect = responses
        monkeypatch.setattr(index, "get_bedrock_client", lambda **_: client)
        return index.judge_relevance("body", ["generative AI"], ["model-a", "model-b"]), client

    def test_yes(self, monkeypatch):
        result, client = self._run(monkeypatch, [self._response("<relevant>yes</relevant>")])
        assert result is True
        prompt = client.converse.call_args.kwargs["messages"][0]["content"][0]["text"]
        assert "<topics><topic>generative AI</topic></topics>" in prompt

    def test_no(self, monkeypatch):
        assert self._run(monkeypatch, [self._response("<relevant> NO </relevant>")])[0] is False

    def test_missing_tag_is_unknown(self, monkeypatch):
        assert self._run(monkeypatch, [self._response("I think so")])[0] is None

    def test_conflicting_answers_are_unknown(self, monkeypatch):
        assert self._run(monkeypatch, [self._response("<relevant>yes</relevant><relevant>no</relevant>")])[0] is None

    def test_falls_back_to_next_model(self, monkeypatch):
        result, client = self._run(monkeypatch, [_FakeClientError("ThrottlingException"), self._response("<relevant>no</relevant>")])
        assert result is False
        assert client.converse.call_count == 2

    def test_every_model_failing_is_unknown(self, monkeypatch):
        assert self._run(monkeypatch, [RuntimeError("x"), _FakeClientError("AccessDeniedException")])[0] is None


class TestPushNotificationFilter:
    """Test the optional notifier filter in push_notification."""

    def _push(self, monkeypatch, notifier_filter=None, filter_result="", relevant=None):
        calls = {"ssm": 0, "judge": [], "summarize": 0, "posted": 0, "updates": []}

        class _Res:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"ok"

        notifier = {"destination": "slack", "summarizerName": "TestSummarizer", "webhookUrlParameterName": "/p"}
        if notifier_filter is not None:
            notifier["filter"] = notifier_filter
        monkeypatch.setattr(index, "NOTIFIERS", {"N": notifier})
        ssm = MagicMock()
        ssm.get_parameter.side_effect = lambda **kw: calls.__setitem__("ssm", calls["ssm"] + 1) or {"Parameter": {"Value": "https://hooks.example.com/x"}}
        table = MagicMock()
        table.update_item.side_effect = lambda **kw: calls["updates"].append(kw)
        monkeypatch.setattr(index, "ssm", ssm)
        monkeypatch.setattr(index, "ddb_table", table)
        monkeypatch.setattr(index, "get_blog_content", lambda url: "body")

        def fake_judge(body, topics, model_ids):
            calls["judge"].append((topics, model_ids))
            return relevant

        def fake_summarize(*a, **k):
            calls["summarize"] += 1
            return "sum", "- d", {"model_id": "m", "latency_sec": 1, "input_tokens": 1, "output_tokens": 1}

        def fake_urlopen(req, *a, **k):
            calls["posted"] += 1
            return _Res()

        monkeypatch.setattr(index, "judge_relevance", fake_judge)
        monkeypatch.setattr(index, "summarize_blog", fake_summarize)
        monkeypatch.setattr(index.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.setattr(index.time, "sleep", lambda s: None)
        item = {"rss_title": "T", "rss_link": "https://example.com/a", "rss_time": "t", "rss_category": "c",
                "rss_notifier_name": "N", "rss_filter_result": filter_result}
        index.push_notification([item])
        return calls

    def test_without_filter_nothing_changes(self, monkeypatch):
        calls = self._push(monkeypatch)
        assert calls["judge"] == [] and calls["summarize"] == 1 and calls["posted"] == 1

    def test_empty_filter_nothing_changes(self, monkeypatch):
        calls = self._push(monkeypatch, notifier_filter={})
        assert calls["judge"] == [] and calls["posted"] == 1

    def test_excluded_by_categories_is_skipped_before_any_call(self, monkeypatch):
        calls = self._push(monkeypatch, filter_result="excluded:categories")
        assert calls["ssm"] == 0 and calls["judge"] == [] and calls["summarize"] == 0 and calls["posted"] == 0

    def test_relevant_article_is_posted(self, monkeypatch):
        calls = self._push(monkeypatch, notifier_filter={"topics": ["AI"]}, relevant=True)
        assert calls["judge"] == [(["AI"], ["model-a", "model-b"])] and calls["posted"] == 1

    def test_judge_uses_filter_model_ids(self, monkeypatch):
        calls = self._push(monkeypatch, notifier_filter={"topics": ["AI"], "modelIds": ["cheap"]}, relevant=True)
        assert calls["judge"] == [(["AI"], ["cheap"])]

    def test_irrelevant_article_is_marked_and_not_posted(self, monkeypatch):
        calls = self._push(monkeypatch, notifier_filter={"topics": ["AI"]}, relevant=False)
        assert calls["summarize"] == 0 and calls["posted"] == 0
        assert calls["updates"][0]["ExpressionAttributeValues"] == {":st": "filtered"}

    def test_unknown_answer_is_posted(self, monkeypatch):
        calls = self._push(monkeypatch, notifier_filter={"topics": ["AI"]}, relevant=None)
        assert calls["summarize"] == 1 and calls["posted"] == 1

    def test_invalid_topics_are_ignored(self, monkeypatch):
        calls = self._push(monkeypatch, notifier_filter={"topics": "AI"})
        assert calls["judge"] == [] and calls["posted"] == 1


class TestGetNewEntriesFilterResult:
    def test_reads_filter_result(self):
        image = {"category": {"S": "c"}, "pubtime": {"S": "t"}, "title": {"S": "T"}, "url": {"S": "u"},
                 "notifier_name": {"S": "N"}, "filter_result": {"S": "excluded:categories"}}
        result = index.get_new_entries([{"eventName": "INSERT", "dynamodb": {"NewImage": image}}])
        assert result[0]["rss_filter_result"] == "excluded:categories"

    def test_missing_filter_result(self):
        image = {"category": {"S": "c"}, "pubtime": {"S": "t"}, "title": {"S": "T"}, "url": {"S": "u"}, "notifier_name": {"S": "N"}}
        result = index.get_new_entries([{"eventName": "INSERT", "dynamodb": {"NewImage": image}}])
        assert result[0]["rss_filter_result"] == ""
