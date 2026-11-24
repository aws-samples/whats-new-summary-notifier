# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import datetime
import json
import os

import boto3
import dateutil.parser
import feedparser
from botocore.exceptions import ClientError

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
    return elapsed_time.days <= 7


def str2datetime(time_str):
    """Convert the date format from the blog text to datetime

    Args:
        time_str (str): The date and time string, e.g., "Tue, 20 Sep 2022 16:05:47 +0000"
    """

    return dateutil.parser.parse(time_str, ignoretz=True)


EXCLUDED_BY_CATEGORIES = "excluded:categories"


def filter_categories(notifier):
    """Return the lower-cased filter.categories of a notifier, or [] when it is not set or invalid"""
    notifier_filter = notifier.get("filter")
    if notifier_filter is None:
        return []
    categories = notifier_filter.get("categories", []) if isinstance(notifier_filter, dict) else None
    if not isinstance(categories, list) or not all(isinstance(c, str) for c in categories):
        print("Ignore filter.categories: it must be a list of strings")
        return []
    return [c.strip().lower() for c in categories if c.strip()]


def entry_tags(entry):
    """Return the lower-cased category tags of an RSS entry

    What's New puts several tags in one <category> element, separated by commas.
    """
    tags = []
    for tag in entry.get("tags") or []:
        term = tag.get("term") if isinstance(tag, dict) else None
        if term:
            tags.extend(t.strip().lower() for t in term.split(",") if t.strip())
    return tags


def matches_categories(tags, categories):
    """True when there is no category filter, the entry has no tags, or a tag matches a category

    A tag matches a category when it is equal to it or starts with the category followed by "/".
    """
    if not categories or not tags:
        return True
    return any(tag == c or tag.startswith(c + "/") for c in categories for tag in tags)


def write_to_table(link, title, category, pubtime, notifier_name, filter_result=None):
    """Write a blog post to DynamoDB

    Args:
        link (str): The URL of the blog post
        title (str): The title of the blog post
        category (str): The category of the blog post
        pubtime (str): The publication date of the blog post
        filter_result (str): Why the notifier filter excluded the post, or None
    """
    try:
        item = {
            "url": link,
            "notifier_name": notifier_name,
            "title": title,
            "category": category,
            "pubtime": pubtime,
        }
        if filter_result:
            item["filter_result"] = filter_result
        print(item)
        table.put_item(Item=item)
    except ClientError as e:
        # Intentional error handling for duplicates to continue
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            print("Duplicate item put: " + title)
        else:
            # Continue for other errors
            print(e)


def add_blog(rss_name, entries, notifier_name, categories=None):
    """Add blog posts

    Posts that do not match the category filter are still written, with filter_result
    set, so that loosening or removing the filter later does not post them all at once.

    Args:
        rss_name (str): The category of the blog (RSS unit)
        entries (List): The list of blog posts
        categories (List): The notifier's filter.categories, lower-cased
    """

    for entry in entries:
        if recently_published(entry["published"]):
            excluded = not matches_categories(entry_tags(entry), categories or [])
            write_to_table(
                entry["link"],
                entry["title"],
                rss_name,
                str2datetime(entry["published"]).isoformat(),
                notifier_name,
                EXCLUDED_BY_CATEGORIES if excluded else None,
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
        add_blog(rss_name, rss_result["entries"], notifier_name, filter_categories(notifier))
