# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import os
import re
import time
import traceback
import urllib.parse
import urllib.request
from typing import Optional

import boto3
import cloudscraper
from botocore.config import Config
from botocore.exceptions import ClientError
from bs4 import BeautifulSoup
from strands import Agent
from strands.models import BedrockModel

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

    if not url.lower().startswith(("http://", "https://")):
        print(f"Invalid URL: {url}")
        return None

    # create a cloudscraper instance
    scraper = cloudscraper.create_scraper()

    # dummy User-Agent
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    }

    try:
        response = scraper.get(url, headers=headers, timeout=5)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, "html.parser")
        main = soup.find("main")

        return main.text if main else None

    except Exception as e:
        print(f"Error accessing {url}: {e}")
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
    summarizer_name,
):
    """Summarize the content of a blog post
    Args:
        blog_body (str): The content of the blog post to be summarized
        language (str): The language for the summary
        persona (str): The persona to use for the summary
        summarizer_name (str): The name of the summarizer to use

    Returns:
        str: The summarized text
    """

    print(f"Summarizing blog with summarizer: {summarizer_name}")
    boto3_bedrock = get_bedrock_client(
        assumed_role=os.environ.get("BEDROCK_ASSUME_ROLE", None),
        region=MODEL_REGION,
    )

    if summarizer_name == "AwsSolutionsArchitectJapanese":
        prompt_data = f"""
<persona>You are a professional {persona} with deep expertise in cloud technologies and enterprise solutions. </persona>
<instruction>
Analyze the AWS update in <input></input> tags and provide structured insights focusing on:
- What specific new feature, service, or enhancement is being announced
- Which AWS services are involved or affected
- What technical benefits this provides (performance, cost, scalability, security, etc.)
- Who would benefit most from this update (enterprise users, developers, specific industries, etc.)
- Any important technical requirements, limitations, or prerequisites

IMPORTANT: When writing in Japanese, use consistent and accurate translations for all AWS service names and technical terms. Maintain professional terminology throughout.

Output your analysis in <thinking></thinking> tags using bullet points (each starting with "- " and ending with "\n").
Create a concise summary following <summaryRule></summaryRule> and format according to <outputFormat></outputFormat>.
Generate a Twitter-ready summary for the <twitter></twitter> section following <twitterRules></twitterRules>.
</instruction>
<outputLanguage>In {language}.</outputLanguage>
<summaryRule>The final summary must be 2-3 sentences that clearly explain the new AWS feature/update, its key benefits, and target audience in a professional yet accessible tone.</summaryRule>
<twitterRules>
STRICT RULES for Twitter summary:
- NEVER use exclamation marks or show excessive excitement
- State objective facts concisely and professionally
- NO hashtags whatsoever
- Keep within 200 characters
- Use neutral, informative tone
- Focus on factual information only
</twitterRules>
<outputFormat><thinking>(detailed bullet point analysis of the AWS update)</thinking><summary>(concise professional summary of the update)</summary><twitter>(Twitter-ready summary within 200 characters following twitterRules strictly)</twitter></outputFormat>
Follow the instructions carefully and focus on technical accuracy and practical implications. When outputting in Japanese, ensure consistent and professional translation of all technical terms and service names.
"""
    elif summarizer_name == "Formula1ProfessionalJapanese":
        prompt_data = f"""
<persona>You are a professional {persona} with extensive knowledge of F1 racing, teams, drivers, regulations, and the motorsport industry. </persona>
<instruction>
Analyze the Formula 1 news in <input></input> tags and provide comprehensive insights covering:
- What is the main F1-related development or news story being reported
- Which F1 teams, drivers, circuits, or officials are involved
- How this impacts the current F1 season, championships, or future races
- What are the technical, regulatory, or strategic implications
- Why this news matters to F1 fans, teams, or the sport overall

IMPORTANT: When writing in Japanese, you MUST use the exact translations provided in the glossary section below for all names, teams, and technical terms. This is mandatory and non-negotiable.

Output your analysis in <thinking></thinking> tags using bullet points (each starting with "- " and ending with "\n").
Create an engaging summary following <summaryRule></summaryRule> and format according to <outputFormat></outputFormat>.
Generate a Twitter-ready summary for the <twitter></twitter> section following <twitterRules></twitterRules>.
</instruction>
<glossary>
MANDATORY TRANSLATION RULES - You MUST follow these translations exactly:
When translating to Japanese, you are REQUIRED to use the following proper nouns and technical terms exactly as specified. DO NOT use any other translations or variations:

<names>
- Max Verstappen: マックス・フェルスタッペン
- Yuki Tsunoda: 角田裕毅
- Lewis Hamilton: ルイス・ハミルトン
- Charles Leclerc: シャルル・ルクレール
- Lando Norris: ランド・ノリス
- Oscar Piastri: オスカー・ピアストリ
- George Russell: ジョージ・ラッセル
- Kimi Antonelli: キミ・アントネッリ
- Carlos Sainz: カルロス・サインツ
- Alex Albon: アレックス・アルボン
- Fernando Alonso: フェルナンド・アロンソ
- Lance Stroll: ランス・ストロール
- Pierre Gasly: ピエール・ガスリー
- Franco Colapinto: フランコ・コラピント
- Esteban Ocon: エスタバン・オコン
- Oliver Bearman: オリバー・ベアマン
- Nico Hulkenberg: ニコ・ヒュルケンベルグ
- Gabriel Bortoleto: ガブリエル・ボルトレート
- Isack Hadjar: アイザック・ハジャー
- Liam Lawson: リアム・ローソン
- Sergio Perez: セルジオ・ペレス
- Valtteri Bottas: バルテリ・ボッタス
- Sebastian Vettel: セバスチャン・ベッテル
- Kimi Räikkönen: キミ・ライックネン
- Christian Horner: クリスチャン・ホーナー
- Toto Wolff: トト・ウォルフ
- Frédéric Vasseur: フレデリック・バスール
- Ayao Komatsu: 小松礼雄
</names>

<teams>
- Red Bull Racing: レッドブル・レーシング
- Mercedes: メルセデス
- Ferrari: フェラーリ
- McLaren: マクラーレン
- Alpine: アルピーヌ
- Aston Martin: アストンマーチン
- Williams: ウィリアムズ
- Haas: ハース
- Alfa Romeo: アルファロメオ
- Racing Bulls: レーシング・ブルズ
- KICK Sauber: キックザウバー
</teams>

<technical_terms>
- Qualifying: 予選
- Practice: フリー走行
- Sprint Race: スプリントレース
- Safety Car: セーフティカー
- Virtual Safety Car: バーチャルセーフティカー
- Undercut: アンダーカット
- Overcut: オーバーカット
- Slipstream: スリップストリーム
- Toe: トゥ
- Downforce: ダウンフォース
- Ground Effect: グラウンドエフェクト
- Porpoising: ポーポイジング
- Parc Fermé: パルクフェルメ
</technical_terms>

CRITICAL: If any of these terms appear in the content, you MUST use the exact Japanese translation provided above. Using any other translation is strictly forbidden and will be considered an error.
</glossary>
<outputLanguage>In {language}.</outputLanguage>
<summaryRule>The final summary must be 2-3 sentences that capture the significance of the F1 news, explaining what happened and why it matters to fans in a professional tone.</summaryRule>
<twitterRules>
STRICT RULES for Twitter summary:
- NEVER use exclamation marks or show excessive excitement
- State objective facts concisely and professionally
- NO hashtags whatsoever
- Keep within 200 characters
- Use neutral, informative tone
- Focus on factual information only
- Avoid emotional language or superlatives
</twitterRules>
<outputFormat><thinking>(detailed bullet point analysis of the F1 news)</thinking><summary>(professional summary that captures the significance of the F1 news)</summary><twitter>(Twitter-ready summary within 200 characters following twitterRules strictly)</twitter></outputFormat>
Follow the instructions carefully and maintain professionalism while providing accurate information. 

MANDATORY GLOSSARY COMPLIANCE: When outputting in Japanese, you MUST strictly adhere to the proper noun translations provided in the glossary above. Any deviation from these translations is strictly prohibited. Before finalizing your output, verify that all names, teams, and technical terms use the exact Japanese translations specified in the glossary.
"""

    max_tokens = 4096

    ## Use Bedrock API
    # system_prompts = [
    #     {
    #         "text": prompt_data
    #     }
    # ]

    # messages = [
    #     {
    #         "role": "user",
    #         "content": [
    #             {
    #                 "text": f"<input>{blog_body}</input>"
    #             }
    #         ]
    #     }
    # ]

    # inference_config = {
    #     "maxTokens": max_tokens,
    #     "temperature": 0.5,
    #     "topP": 1,
    # }

    # additional_model_request_fields = {
    #     "inferenceConfig": {
    #         "topK": 250
    #     }
    # }
    # try:
    #     response = boto3_bedrock.converse(
    #         system=system_prompts,
    #         messages=messages,
    #         modelId=MODEL_ID,
    #         inferenceConfig=inference_config,
    #         additionalModelRequestFields=additional_model_request_fields
    #     )

    #    outputText = response["output"]["message"]["content"][0]["text"]

    ## Use Strands API
    model = BedrockModel(
        params={
            "temperature": 1.0,
            "top_p": 1.0,
            "max_completion_tokens": max_tokens
        },
        additional_request_fields={
            "reasoning_effort": "medium"
        },
        model_id=MODEL_ID,
        region_name=MODEL_REGION,
        streaming=False,
    )

    agent = Agent(
        model=model,
        system_prompt=prompt_data,
        callback_handler=None,
    )
    try:
        response = agent(blog_body)

        outputText = None
        for content in response.message["content"]:
            if "text" in content:
                outputText = content["text"]
                break

        if outputText is None:
            raise ValueError("No text content found in response")
        # extract contant inside <summary> tag
        summary = re.findall(r"<summary>([\s\S]*?)</summary>", outputText)[0]
        detail = re.findall(r"<thinking>([\s\S]*?)</thinking>", outputText)[0]
        twitter = re.findall(r"<twitter>([\s\S]*?)</twitter>", outputText)[0]
    except ClientError as error:
        if error.response["Error"]["Code"] == "AccessDeniedException":
            print(
                f"{error.response['Error']['Message']}"
                "\nTo troubeshoot this issue please refer to the following resources:\n"
                "https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_access-denied.html\n"
                "https://docs.aws.amazon.com/bedrock/latest/userguide/security-iam.html\n"
            )
        else:
            raise error

    return summary, detail, twitter


def push_notification(item_list):
    """Notify the arrival of articles

    Args:
        item_list (list): List of articles to be notified
    """

    for item in item_list:

        notifier = NOTIFIERS[item["rss_notifier_name"]]
        webhook_url_parameter_name = notifier["webhookUrlParameterName"]
        ssm_response = ssm.get_parameter(Name=webhook_url_parameter_name, WithDecryption=True)
        app_webhook_url = ssm_response["Parameter"]["Value"]

        item_url = item["rss_link"]

        # Get the blog context
        content = get_blog_content(item_url)

        # Summarize the blog
        summarizer = SUMMARIZERS[notifier["summarizerName"]]
        summary, detail, twitter = summarize_blog(content, language=summarizer["outputLanguage"], persona=summarizer["persona"], summarizer_name=notifier["summarizerName"])

        # Add the summary text to notified message
        item["summary"] = summary
        item["detail"] = detail
        item["twitter"] = twitter

        item["twitter"] = item["twitter"].replace("\n", "")
        msg = create_slack_message(item)

        encoded_msg = json.dumps(msg).encode("utf-8")
        # print("push_msg:{}".format(item))
        print("push_msg:{}".format(msg))
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


def create_slack_message(item):
    # URL encode the twitter text
    # encoded_twitter_text = urllib.parse.quote("🤖 < " + item["twitter"] + " (生成AIによる要約ポスト)")
    encoded_twitter_text = urllib.parse.quote(item["twitter"])

    # URL encode the RSS link separately
    encoded_rss_link = urllib.parse.quote(item["rss_link"])

    message = {
        "text": f"{item['rss_time']}\n" \
                f"<{item['rss_link']}|{item['rss_title']}>\n" \
                f"{item['summary']}\n" \
                f"{item['detail']}\n" \
                f"<https://x.com/intent/tweet?url={encoded_rss_link}&text={encoded_twitter_text}|Share on X>"
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
    except Exception:
        print(traceback.print_exc())
