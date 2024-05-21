# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import boto3
import datetime
import feedparser
import json
import os
import dateutil.parser

# CRAWL_BLOG_URL = json.loads(os.environ["RSS_URL"])
# NOTIFIERS = json.loads(os.environ["NOTIFIERS"])

DDB_TABLE_NAME = os.environ["DDB_TABLE_NAME"]
dynamo = boto3.resource("dynamodb")
table = dynamo.Table(DDB_TABLE_NAME)


def recently_published(pubdate):
    """Check if the publication date is recent

    Args:
        pubdate (str): The publication date and time
    """

    elapsed_time = datetime.datetime.now() - str2datetime(pubdate)
    print(elapsed_time)
    if elapsed_time.days > 7:
        return False

    return True


def str2datetime(time_str):
    """Convert the date format from the blog text to datetime

    Args:
        time_str (str): The date and time string, e.g., "Tue, 20 Sep 2022 16:05:47 +0000"
    """

    return dateutil.parser.parse(time_str, ignoretz=True)


def write_to_table(link, title, category, pubtime, notifier_name):
    """Write a blog post to DynamoDB

    Args:
        link (str): The URL of the blog post
        title (str): The title of the blog post
        category (str): The category of the blog post
        pubtime (str): The publication date of the blog post
    """
    try:
        item = {
            "url": link,
            "notifier_name": notifier_name,
            "title": title,
            "category": category,
            "pubtime": pubtime,
        }
        print(item)
        table.put_item(Item=item)
    except Exception as e:
        # Intentional error handling for duplicates to continue
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            print("Duplicate item put: " + title)
        else:
            # Continue for other errors
            print(e.message)


def add_blog(rss_name, entries, notifier_name):
    """Add blog posts

    Args:
        rss_name (str): The category of the blog (RSS unit)
        entries (List): The list of blog posts
    """

    for entry in entries:
        if recently_published(entry["published"]):
            write_to_table(
                entry["link"],
                entry["title"],
                rss_name,
                str2datetime(entry["published"]).isoformat(),
                notifier_name,
            )
        else:
            print("Old blog entry. skip: " + entry["title"])


def handler(event, context):

    notifier_name, notifier = event.values()

    rss_urls = notifier["rssUrl"]
    for rss_name, rss_url in rss_urls.items():
        rss_result = feedparser.parse(rss_url)
        print(json.dumps(rss_result))
        print("RSS updated " + rss_result["feed"]["updated"])
        if not recently_published(rss_result["feed"]["updated"]):
            # Do not process RSS feeds that have not been updated for a certain period of time.
            # If you want to retrieve from the past, change this number of days and re-import.
            print("Skip RSS " + rss_name)
            continue
        add_blog(rss_name, rss_result["entries"], notifier_name)
