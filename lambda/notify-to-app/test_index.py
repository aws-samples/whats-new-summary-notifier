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

    def test_matches_workflows_webhook_schema(self):
        """The body matches the Workflows webhook trigger's Adaptive Card schema."""
        item = {"rss_title": "T", "rss_link": "https://example.com", "summary": "s", "detail": "- d"}
        msg = index.create_teams_message(item)
        attachment = msg["attachments"][0]
        assert set(attachment) == {"contentType", "contentUrl", "content"}
        assert attachment["contentType"] == "application/vnd.microsoft.card.adaptive"
        assert attachment["contentUrl"] is None
        # Workflows webhooks support every Adaptive Card element except Action.Submit
        assert "Action.Submit" not in json.dumps(msg)


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

    def test_teams(self, monkeypatch):
        posted = self._push(monkeypatch, "teams")
        assert posted[0]["type"] == "message"
        assert posted[0]["attachments"][0]["contentUrl"] is None
        assert posted[0]["attachments"][0]["content"]["type"] == "AdaptiveCard"

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

    def _push(self, monkeypatch, notifier_filter=None, filter_result="", relevant=None, content="body", description=""):
        calls = {"ssm": 0, "judge": [], "judged": [], "summarize": 0, "posted": 0, "updates": []}

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
        monkeypatch.setattr(index, "get_blog_content", lambda url: content)
        monkeypatch.setattr(index.article, "description_text", lambda d: d.replace("<p>", "").replace("</p>", ""))

        def fake_judge(body, topics, model_ids):
            calls["judge"].append((topics, model_ids))
            calls["judged"].append(body)
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
                "rss_notifier_name": "N", "rss_filter_result": filter_result, "rss_description": description}
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

    def test_excluded_by_categories_is_skipped_even_with_a_description(self, monkeypatch):
        calls = self._push(monkeypatch, filter_result="excluded:categories", content=None, description="<p>desc</p>")
        assert calls["ssm"] == 0 and calls["judge"] == [] and calls["summarize"] == 0 and calls["posted"] == 0

    def test_topics_check_reads_the_article(self, monkeypatch):
        body = "x" * index.article.MIN_CHARS
        calls = self._push(monkeypatch, notifier_filter={"topics": ["AI"]}, relevant=True, content=body, description="<p>desc</p>")
        assert calls["judged"] == [body]

    def test_topics_check_reads_the_rss_description_when_the_article_is_missing(self, monkeypatch):
        calls = self._push(monkeypatch, notifier_filter={"topics": ["AI"]}, relevant=False, content=None, description="<p>desc</p>")
        assert calls["judged"] == ["desc"] and calls["summarize"] == 0 and calls["posted"] == 0

    def test_nothing_to_read_is_skipped_before_the_topics_check(self, monkeypatch):
        calls = self._push(monkeypatch, notifier_filter={"topics": ["AI"]}, relevant=True, content=None, description="")
        assert calls["judge"] == [] and calls["summarize"] == 0 and calls["posted"] == 0


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


class TestGetNewEntriesDescription:
    """Test that the RSS description is read from the stream record when present."""

    def _record(self, extra):
        image = {
            "category": {"S": "c"},
            "pubtime": {"S": "t"},
            "title": {"S": "T"},
            "url": {"S": "https://example.com/a"},
            "notifier_name": {"S": "TestNotifier"},
            **extra,
        }
        return [{"eventName": "INSERT", "dynamodb": {"NewImage": image}}]

    def test_with_description(self):
        result = index.get_new_entries(self._record({"rss_description": {"S": "<p>desc</p>"}}))
        assert result[0]["rss_description"] == "<p>desc</p>"

    def test_without_description(self):
        assert index.get_new_entries(self._record({}))[0]["rss_description"] == ""


class TestPushNotificationFallback:
    """Test the fallback to the RSS description when the article cannot be used."""

    def _push(self, monkeypatch, content, description):
        summarized, updates = [], []

        class _Res:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"ok"

        ssm = MagicMock()
        ssm.get_parameter.return_value = {"Parameter": {"Value": "https://hooks.example.com/x"}}
        table = MagicMock()
        table.update_item.side_effect = lambda **kw: updates.append(kw)
        monkeypatch.setattr(index, "ssm", ssm)
        monkeypatch.setattr(index, "ddb_table", table)
        monkeypatch.setattr(index, "get_blog_content", lambda url: content)
        monkeypatch.setattr(index.article, "description_text", lambda d: d.replace("<p>", "").replace("</p>", ""))

        def fake_summarize(body, **kwargs):
            summarized.append(body)
            return "sum", "- d", {"model_id": "m", "latency_sec": 1, "input_tokens": 1, "output_tokens": 1}

        monkeypatch.setattr(index, "summarize_blog", fake_summarize)
        monkeypatch.setattr(index.urllib.request, "urlopen", lambda req, *a, **k: _Res())
        monkeypatch.setattr(index.time, "sleep", lambda s: None)
        item = {"rss_title": "T", "rss_link": "https://example.com/a", "rss_time": "t", "rss_category": "c",
                "rss_notifier_name": "TestNotifier", "rss_description": description}
        index.push_notification([item])
        sources = [u["ExpressionAttributeValues"][":src"] for u in updates]
        return summarized, sources

    def test_uses_article_when_long_enough(self, monkeypatch):
        body = "x" * index.article.MIN_CHARS
        assert self._push(monkeypatch, body, "<p>desc</p>") == ([body], ["article"])

    def test_uses_description_when_article_missing(self, monkeypatch):
        assert self._push(monkeypatch, None, "<p>desc</p>") == (["desc"], ["rss_description"])

    def test_uses_description_when_article_too_short(self, monkeypatch):
        assert self._push(monkeypatch, "short", "<p>desc</p>") == (["desc"], ["rss_description"])

    def test_keeps_short_article_without_description(self, monkeypatch):
        assert self._push(monkeypatch, "short", "") == (["short"], ["article"])

    def test_skips_when_nothing_is_available(self, monkeypatch):
        assert self._push(monkeypatch, None, "") == ([], [])
