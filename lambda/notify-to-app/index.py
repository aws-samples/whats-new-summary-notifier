# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import boto3
import json
import os
import time
import traceback

import urllib.request

from typing import Optional
from botocore.config import Config
from bs4 import BeautifulSoup
from botocore.exceptions import ClientError
import re

MODEL_ID = os.environ["MODEL_ID"]
MODEL_REGION = os.environ["MODEL_REGION"]
NOTIFIERS = json.loads(os.environ["NOTIFIERS"])
SUMMARIZERS = json.loads(os.environ["SUMMARIZERS"])

ssm = boto3.client("ssm")


def get_blog_content(url):
    """Retrieve the content of a blog post

    Args:
        url (str): The URL of the blog post

    Returns:
        str: The content of the blog post, or None if it cannot be retrieved.
    """

    try:
        if url.lower().startswith(("http://", "https://")):
            # Use the `with` statement to ensure the response is properly closed
            with urllib.request.urlopen(url) as response:
                html = response.read()
                if response.getcode() == 200:
                    soup = BeautifulSoup(html, "html.parser")
                    main = soup.find("main")

                    if main:
                        return main.text
                    else:
                        return None

        else:
            print(f"Error accessing {url}, status code {response.getcode()}")
            return None

    except urllib.error.URLError as e:
        print(f"Error accessing {url}: {e.reason}")
        return None


def get_bedrock_client(
    assumed_role: Optional[str] = None,
    region: Optional[str] = None,
    runtime: Optional[bool] = True,
):
    """Create a boto3 client for Amazon Bedrock, with optional configuration overrides

    Args:
        assumed_role (Optional[str]): Optional ARN of an AWS IAM role to assume for calling the Bedrock service. If not
            specified, the current active credentials will be used.
        region (Optional[str]): Optional name of the AWS Region in which the service should be called (e.g. "us-east-1").
            If not specified, AWS_REGION or AWS_DEFAULT_REGION environment variable will be used.
        runtime (Optional[bool]): Optional choice of getting different client to perform operations with the Amazon Bedrock service.
    """

    if region is None:
        target_region = os.environ.get(
            "AWS_REGION", os.environ.get("AWS_DEFAULT_REGION")
        )
    else:
        target_region = region

    print(f"Create new client\n  Using region: {target_region}")
    session_kwargs = {"region_name": target_region}
    client_kwargs = {**session_kwargs}

    profile_name = os.environ.get("AWS_PROFILE")
    if profile_name:
        print(f"  Using profile: {profile_name}")
        session_kwargs["profile_name"] = profile_name

    retry_config = Config(
        region_name=target_region,
        retries={
            "max_attempts": 10,
            "mode": "standard",
        },
    )
    session = boto3.Session(**session_kwargs)

    if assumed_role:
        print(f"  Using role: {assumed_role}", end="")
        sts = session.client("sts")
        response = sts.assume_role(
            RoleArn=str(assumed_role), RoleSessionName="langchain-llm-1"
        )
        print(" ... successful!")
        client_kwargs["aws_access_key_id"] = response["Credentials"]["AccessKeyId"]
        client_kwargs["aws_secret_access_key"] = response["Credentials"][
            "SecretAccessKey"
        ]
        client_kwargs["aws_session_token"] = response["Credentials"]["SessionToken"]

    if runtime:
        service_name = "bedrock-runtime"
    else:
        service_name = "bedrock"

    bedrock_client = session.client(
        service_name=service_name, config=retry_config, **client_kwargs
    )

    return bedrock_client


def summarize_blog(
    blog_body,
    language,
    persona,
):
    """Summarize the content of a blog post
    Args:
        blog_body (str): The content of the blog post to be summarized
        language (str): The language for the summary
        persona (str): The persona to use for the summary

    Returns:
        str: The summarized text
    """

    boto3_bedrock = get_bedrock_client(
        assumed_role=os.environ.get("BEDROCK_ASSUME_ROLE", None),
        region=MODEL_REGION,
    )
    beginning_word = "<output>"
    prompt_data = f"""
<input>{blog_body}</input>
<persona>You are a professional {persona}. </persona>
<instruction>Describe a new update in <input></input> tags in bullet points to describe "What is the new feature", "Who is this update good for". description shall be output in <thinking></thinking> tags and each thinking sentence must start with the bullet point "- " and end with "\n". Make final summary as per <summaryRule></summaryRule> tags. Try to shorten output for easy reading. You are not allowed to utilize any information except in the input. output format shall be in accordance with <outputFormat></outputFormat> tags.</instruction>
<outputLanguage>In {language}.</outputLanguage>
<summaryRule>The final summary must consists of 1 or 2 sentences. Output format is defined in <outputFormat></outputFormat> tags.</summaryRule>
<outputFormat><thinking>(bullet points of the input)</thinking><summary>(final summary)</summary></outputFormat>
Follow the instruction.
"""

    max_tokens = 4096

    user_message = {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": prompt_data,
            }
        ],
    }

    assistant_message = {
        "role": "assistant",
        "content": [{"type": "text", "text": f"{beginning_word}"}],
    }

    messages = [user_message, assistant_message]

    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "messages": messages,
            "temperature": 0.5,
            "top_p": 1,
            "top_k": 250,
        }
    )

    accept = "application/json"
    contentType = "application/json"
    outputText = "\n"

    try:
        response = boto3_bedrock.invoke_model(
            body=body, modelId=MODEL_ID, accept=accept, contentType=contentType
        )
        response_body = json.loads(response.get("body").read().decode())
        outputText = beginning_word + response_body.get("content")[0]["text"]
        print(outputText)
        # extract contant inside <summary> tag
        summary = re.findall(r"<summary>([\s\S]*?)</summary>", outputText)[0]
        detail = re.findall(r"<thinking>([\s\S]*?)</thinking>", outputText)[0]
    except ClientError as error:
        if error.response["Error"]["Code"] == "AccessDeniedException":
            print(
                f"\x1b[41m{error.response['Error']['Message']}\
            \nTo troubeshoot this issue please refer to the following resources.\ \nhttps://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_access-denied.html\
            \nhttps://docs.aws.amazon.com/bedrock/latest/userguide/security-iam.html\x1b[0m\n"
            )
        else:
            raise error

    return summary, detail


def push_notification(item_list):
    """Notify the arrival of articles

    Args:
        item_list (list): List of articles to be notified
    """

    for item in item_list:
        
        notifier = NOTIFIERS[item["rss_notifier_name"]]
        webhook_url_parameter_name = notifier["webhookUrlParameterName"]
        destination = notifier["destination"]
        ssm_response = ssm.get_parameter(Name=webhook_url_parameter_name, WithDecryption=True)
        app_webhook_url = ssm_response["Parameter"]["Value"]
        
        item_url = item["rss_link"]

        # Get the blog context
        content = get_blog_content(item_url)

        # Summarize the blog
        summarizer = SUMMARIZERS[notifier["summarizerName"]]
        summary, detail = summarize_blog(content, language=summarizer["outputLanguage"], persona=summarizer["persona"])

        # Add the summary text to notified message
        item["summary"] = summary
        item["detail"] = detail
        if destination == "teams":
            item["detail"] = item["detail"].replace("。\n", "。\r")
            msg = create_teams_message(item)
        else:  # Slack
            msg = item

        encoded_msg = json.dumps(msg).encode("utf-8")
        print("push_msg:{}".format(item))
        headers = {
            "Content-Type": "application/json",
        }
        req = urllib.request.Request(app_webhook_url, encoded_msg, headers)
        with urllib.request.urlopen(req) as res:
            print(res.read())
        time.sleep(0.5)


def get_new_entries(blog_entries):
    """Determine if there are new blog entries to notify on Slack by checking the eventName

    Args:
        blog_entries (list): List of blog entries registered in DynamoDB
    """

    res_list = []
    for entry in blog_entries:
        print(entry)
        if entry["eventName"] == "INSERT":
            new_data = {
                "rss_category": entry["dynamodb"]["NewImage"]["category"]["S"],
                "rss_time": entry["dynamodb"]["NewImage"]["pubtime"]["S"],
                "rss_title": entry["dynamodb"]["NewImage"]["title"]["S"],
                "rss_link": entry["dynamodb"]["NewImage"]["url"]["S"],
                "rss_notifier_name": entry["dynamodb"]["NewImage"]["notifier_name"]["S"],
            }
            print(new_data)
            res_list.append(new_data)
        else:  # Do not notify for REMOVE or UPDATE events
            print("skip REMOVE or UPDATE event")
    return res_list


def create_teams_message(item):
    message = {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "type": "AdaptiveCard",
                    "version": "1.3",
                    "body": [
                        {
                            "type": "ColumnSet",
                            "columns": [
                                {
                                    "type": "Column",
                                    "width": "auto",
                                    "items": [
                                        {
                                            "type": "Container",
                                            "id": "collapsedItems",
                                            "items": [
                                                {
                                                    "type": "TextBlock",
                                                    "text": f'**{item["rss_title"]}**',
                                                },
                                                {
                                                    "type": "TextBlock",
                                                    "wrap": True,
                                                    "text": f'{item["summary"]}',
                                                },
                                            ],
                                        },
                                        {
                                            "type": "Container",
                                            "id": "expandedItems",
                                            "isVisible": False,
                                            "items": [
                                                {
                                                    "type": "TextBlock",
                                                    "wrap": True,
                                                    "text": f'{item["detail"]}',
                                                }
                                            ],
                                        },
                                    ],
                                }
                            ],
                        },
                        {
                            "type": "Container",
                            "items": [
                                {
                                    "type": "ColumnSet",
                                    "columns": [
                                        {
                                            "type": "Column",
                                            "width": "stretch",
                                            "items": [
                                                {
                                                    "type": "TextBlock",
                                                    "text": "see less",
                                                    "id": "collapse",
                                                    "isVisible": False,
                                                    "wrap": True,
                                                    "color": "Accent",
                                                },
                                                {
                                                    "type": "TextBlock",
                                                    "text": "see more",
                                                    "id": "expand",
                                                    "wrap": True,
                                                    "color": "Accent",
                                                },
                                            ],
                                        }
                                    ],
                                    "selectAction": {
                                        "type": "Action.ToggleVisibility",
                                        "targetElements": [
                                            "collapse",
                                            "expand",
                                            "expandedItems",
                                        ],
                                    },
                                }
                            ],
                        },
                    ],
                    "actions": [
                        {
                            "type": "Action.OpenUrl",
                            "title": "Open Link",
                            "wrap": True,
                            "url": f'{item["rss_link"]}',
                        }
                    ],
                    "msteams": {"width": "Full"},
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                },
            }
        ],
    }

    return message


def handler(event, context):
    """Notify about blog entries registered in DynamoDB

    Args:
        event (dict): Information about the updated items notified from DynamoDB
    """

    try:
        new_data = get_new_entries(event["Records"])
        if 0 < len(new_data):
            push_notification(new_data)
    except Exception as e:
        print(traceback.print_exc())
