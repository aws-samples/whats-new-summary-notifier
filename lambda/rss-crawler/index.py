# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import datetime
import json
import logging
import os

import boto3
import dateutil.parser
import feedparser
from botocore.exceptions import ClientError

# Logs go through the standard logging module, so each line carries its level and the request ID
# and a multi-line message stays one log event. The feed line stays print: see crawl_feed.
logger = logging.getLogger()
if not os.environ.get("AWS_LAMBDA_LOG_LEVEL"):
    # With the TEXT log format the Python runtime sends only WARNING and above; keep INFO as print
    # did. With the JSON log format Lambda sets AWS_LAMBDA_LOG_LEVEL and the runtime applies it.
    logger.setLevel(logging.INFO)

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
    logger.info(elapsed_time)
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
        logger.warning("Ignore filter.categories: it must be a list of strings")
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


MAX_DESCRIPTION_CHARS = 5000


def write_to_table(link, title, category, pubtime, notifier_name, description="", filter_result=None):
    """Write a blog post to DynamoDB

    Args:
        link (str): The URL of the blog post
        title (str): The title of the blog post
        category (str): The category of the blog post
        pubtime (str): The publication date of the blog post
        description (str): The RSS description, used when the article page cannot be read
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
        if description:
            item["rss_description"] = description[:MAX_DESCRIPTION_CHARS]
        if filter_result:
            item["filter_result"] = filter_result
        logger.info({k: v for k, v in item.items() if k != "rss_description"})
        # Write only new posts: overwriting an existing item would drop its summary and
        # summary_status, and would send a MODIFY record to the notify Lambda
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(#url)",
            ExpressionAttributeNames={"#url": "url"},
        )
    except ClientError as e:
        # The post is already stored: expected on every crawl, so continue
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info("Duplicate item put: " + title)
        else:
            # Any other error fails the crawl, so the retry and the dropped-crawl alarm see it.
            # A retry cannot write a post twice: the write is conditional.
            raise


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
                entry.get("summary", ""),
                filter_result=EXCLUDED_BY_CATEGORIES if excluded else None,
            )
        else:
            logger.info("Old blog entry. skip: " + entry["title"])


class FeedError(Exception):
    """An RSS feed could not be read."""


class CrawlError(Exception):
    """One or more RSS feeds of a notifier failed; the others were still crawled."""


def crawl_feed(rss_name, rss_url, notifier_name, categories):
    """Read one RSS feed and write its recent posts

    Raises:
        FeedError: the feed could not be fetched or parsed, or it has no updated date
    """
    rss_result = feedparser.parse(rss_url)
    # default=str: feedparser puts the exception of a failed fetch or parse in the result.
    # This line stays a print: as a logging message it would be escaped again in the JSON log format.
    print(json.dumps(rss_result, default=str))
    # feedparser does not raise on a network or parse error; it sets bozo_exception instead
    if not rss_result.get("entries") and rss_result.get("bozo_exception") is not None:
        raise FeedError(f"cannot read the feed: {rss_result['bozo_exception']!r}")
    updated = (rss_result.get("feed") or {}).get("updated")
    if not updated:
        raise FeedError("the feed has no updated date")
    logger.info("RSS updated " + updated)
    if not recently_published(updated):
        # Do not process RSS feeds that have not been updated for a certain period of time.
        # If you want to retrieve from the past, change this number of days and re-import.
        logger.info("Skip RSS " + rss_name)
        return
    add_blog(rss_name, rss_result["entries"], notifier_name, categories)


def handler(event, context):

    notifier_name, notifier = event.values()

    # Crawl every feed, then fail if any failed: one broken feed does not stop the others
    failed = []
    for rss_name, rss_url in notifier["rssUrl"].items():
        try:
            crawl_feed(rss_name, rss_url, notifier_name, filter_categories(notifier))
        except Exception as error:  # noqa: BLE001 - reported below, after the other feeds
            logger.error(f"RSS {rss_name} ({rss_url}) of {notifier_name} failed: {error!r}")
            failed.append(rss_name)
    if failed:
        raise CrawlError(f"{len(failed)} RSS feed(s) of {notifier_name} failed: {', '.join(failed)}")
