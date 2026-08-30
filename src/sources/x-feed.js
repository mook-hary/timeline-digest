import { writeJsonAtomic } from "../lib/atomic-write.js";
import { fetchJson } from "../lib/fetch-json.js";
import { ValidationError } from "../lib/errors.js";

export const X_FEED_SOURCE = "x-timeline-collector";
export const X_FEED_SCHEMA_VERSION = 1;
export const X_SOURCE_TYPE = "x";
export const NORMALIZED_SCHEMA_VERSION = 1;

const REQUIRED_TOP_LEVEL = [
  "schemaVersion",
  "source",
  "generatedAt",
  "scope",
  "items",
];

const REQUIRED_ITEM_KEYS = [
  "id",
  "title",
  "summary",
  "category",
  "sourceType",
  "sourceUrl",
  "postedAt",
  "collectedAt",
  "author",
  "scores",
];

const NULLABLE_STRING_KEYS = [
  "title",
  "summary",
  "category",
  "sourceType",
  "sourceUrl",
  "postedAt",
  "collectedAt",
];

const SCORE_KEYS = [
  "informationValue",
  "personalRelevance",
  "impact",
  "attentionSignal",
  "importance",
];

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value) {
  return value == null ? null : value;
}

function nullableNumber(value) {
  return value == null ? null : value;
}

export function buildNormalizedId(originalId) {
  return `${X_SOURCE_TYPE}:${X_FEED_SOURCE}:${originalId}`;
}

export function validateXFeed(feed) {
  if (!isPlainObject(feed)) {
    throw new ValidationError("Feed must be an object");
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!Object.hasOwn(feed, key)) {
      throw new ValidationError(`Missing top-level field: ${key}`);
    }
  }

  if (feed.schemaVersion !== X_FEED_SCHEMA_VERSION) {
    throw new ValidationError(
      `Unsupported schemaVersion: ${feed.schemaVersion}`
    );
  }

  if (feed.source !== X_FEED_SOURCE) {
    throw new ValidationError(`Unexpected source: ${feed.source}`);
  }

  if (typeof feed.generatedAt !== "string" || feed.generatedAt.trim() === "") {
    throw new ValidationError("generatedAt must be a non-empty string");
  }

  if (!isPlainObject(feed.scope)) {
    throw new ValidationError("scope must be an object");
  }

  if (!Number.isInteger(feed.scope.itemCount) || feed.scope.itemCount < 0) {
    throw new ValidationError("scope.itemCount must be a non-negative integer");
  }

  if (!Array.isArray(feed.items)) {
    throw new ValidationError("items must be an array");
  }

  if (feed.scope.itemCount !== feed.items.length) {
    throw new ValidationError(
      `scope.itemCount (${feed.scope.itemCount}) does not match items.length (${feed.items.length})`
    );
  }

  const seenIds = new Map();
  feed.items.forEach((item, index) => {
    validateXFeedItem(item, index);
    const previousIndex = seenIds.get(item.id);
    if (previousIndex !== undefined) {
      throw new ValidationError(
        `Duplicate item.id "${item.id}" at items[${previousIndex}] and items[${index}]`
      );
    }
    seenIds.set(item.id, index);
  });
  return feed;
}

function validateXFeedItem(item, index) {
  const prefix = `items[${index}]`;

  if (!isPlainObject(item)) {
    throw new ValidationError(`${prefix} must be an object`);
  }

  for (const key of REQUIRED_ITEM_KEYS) {
    if (!Object.hasOwn(item, key)) {
      throw new ValidationError(`${prefix} missing field: ${key}`);
    }
  }

  if (typeof item.id !== "string" || item.id.trim() === "") {
    throw new ValidationError(`${prefix}.id must be a non-empty string`);
  }

  for (const key of NULLABLE_STRING_KEYS) {
    if (item[key] != null && typeof item[key] !== "string") {
      throw new ValidationError(`${prefix}.${key} must be a string or null`);
    }
  }

  if (
    item.sourceType != null &&
    item.sourceType !== X_SOURCE_TYPE
  ) {
    throw new ValidationError(
      `${prefix}.sourceType must be "${X_SOURCE_TYPE}" or null`
    );
  }

  if (item.author != null && !isPlainObject(item.author)) {
    throw new ValidationError(`${prefix}.author must be an object or null`);
  }

  if (item.author) {
    for (const key of ["name", "handle"]) {
      if (
        Object.hasOwn(item.author, key) &&
        item.author[key] != null &&
        typeof item.author[key] !== "string"
      ) {
        throw new ValidationError(
          `${prefix}.author.${key} must be a string or null`
        );
      }
    }
  }

  if (item.scores != null && !isPlainObject(item.scores)) {
    throw new ValidationError(`${prefix}.scores must be an object or null`);
  }

  if (item.scores) {
    for (const key of SCORE_KEYS) {
      const value = item.scores[key];
      if (value != null && typeof value !== "number") {
        throw new ValidationError(
          `${prefix}.scores.${key} must be a number or null`
        );
      }
    }
  }
}

function normalizeAuthor(author) {
  if (!isPlainObject(author)) {
    return { name: null, handle: null };
  }
  return {
    name: nullableString(author.name),
    handle: nullableString(author.handle),
  };
}

function normalizeScores(scores) {
  const source = isPlainObject(scores) ? scores : {};
  return {
    informationValue: nullableNumber(source.informationValue),
    personalRelevance: nullableNumber(source.personalRelevance),
    impact: nullableNumber(source.impact),
    attentionSignal: nullableNumber(source.attentionSignal),
    importance: nullableNumber(source.importance),
  };
}

export function normalizeXFeedItem(item) {
  return {
    id: buildNormalizedId(item.id),
    source: {
      type: item.sourceType || X_SOURCE_TYPE,
      provider: X_FEED_SOURCE,
      url: nullableString(item.sourceUrl),
      originalId: item.id,
      author: normalizeAuthor(item.author),
    },
    title: nullableString(item.title),
    summary: nullableString(item.summary),
    category: nullableString(item.category),
    publishedAt: nullableString(item.postedAt),
    collectedAt: nullableString(item.collectedAt),
    scores: normalizeScores(item.scores),
  };
}

export function normalizeXFeed(feed, { generatedAt, feedUrl } = {}) {
  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    sourceFeeds: [
      {
        provider: X_FEED_SOURCE,
        type: X_SOURCE_TYPE,
        url: feedUrl || null,
        sourceGeneratedAt: feed.generatedAt,
        itemCount: feed.items.length,
      },
    ],
    items: feed.items.map(normalizeXFeedItem),
  };
}

export async function ingestXFeed(options = {}) {
  const { url, rawPath, normalizedPath, fetchImpl, now } = options;

  const feed = await fetchJson(url, { fetchImpl });
  validateXFeed(feed);
  await writeJsonAtomic(rawPath, feed);

  const generatedAt = typeof now === "function" ? now() : new Date().toISOString();
  const normalized = normalizeXFeed(feed, { generatedAt, feedUrl: url });
  await writeJsonAtomic(normalizedPath, normalized);

  return {
    fetched: feed.items.length,
    normalized: normalized.items.length,
    generatedAt: feed.generatedAt,
    rawPath,
    normalizedPath,
  };
}
