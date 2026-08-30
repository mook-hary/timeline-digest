import path from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "../lib/atomic-write.js";
import { fetchText } from "../lib/fetch-text.js";
import { htmlToPlainText } from "../lib/html-text.js";
import { toIso8601OrNull } from "../lib/iso-date.js";
import { ValidationError } from "../lib/errors.js";
import { parseFeedXml } from "./web-feed-parse.js";
import {
  enabledWebSources,
  loadWebSources,
  validateWebSourcesConfig,
} from "./web-sources.js";
import {
  buildWebItemId,
  compactStableId,
  resolveOriginalId,
} from "./web-stable-id.js";

export const WEB_SOURCE_TYPE = "web";
export const NORMALIZED_SCHEMA_VERSION = 1;
export const FALLBACK_CATEGORY = "その他";

const NULL_SCORES = {
  informationValue: null,
  personalRelevance: null,
  impact: null,
  attentionSignal: null,
  importance: null,
};

export function emptyScores() {
  return { ...NULL_SCORES };
}

export function resolveCategory(itemCategory, defaultCategory) {
  const fromItem = nonempty(itemCategory);
  if (fromItem) return fromItem;
  const fromSource = nonempty(defaultCategory);
  if (fromSource) return fromSource;
  return FALLBACK_CATEGORY;
}

export function normalizeWebItem(parsedItem, source, collectedAt) {
  const originalId = resolveOriginalId(parsedItem);
  if (!originalId) {
    throw new ValidationError("Feed item is missing guid/id and link URL");
  }

  const authorName = nonempty(parsedItem.authorName);

  return {
    id: buildWebItemId(source.id, originalId),
    source: {
      type: WEB_SOURCE_TYPE,
      provider: source.id,
      url: nonempty(parsedItem.url),
      originalId: compactStableId(originalId),
      author: {
        name: authorName,
        handle: null,
      },
    },
    title: htmlToPlainText(parsedItem.title),
    summary: htmlToPlainText(parsedItem.summary),
    category: resolveCategory(parsedItem.category, source.defaultCategory),
    publishedAt: toIso8601OrNull(parsedItem.publishedAt),
    collectedAt,
    scores: emptyScores(),
  };
}

export async function ingestWebFeeds(options = {}) {
  const config = options.sourcesConfig
    ? validateWebSourcesConfig(options.sourcesConfig)
    : await loadWebSources(options.configPath);

  const enabled = enabledWebSources(config);
  if (enabled.length === 0) {
    throw new ValidationError("No enabled web sources");
  }

  const collectedAt =
    typeof options.now === "function" ? options.now() : new Date().toISOString();

  const sourceResults = [];
  for (const source of enabled) {
    sourceResults.push(
      await ingestOneSource({
        source,
        rawDir: options.rawDir,
        fetchImpl: options.fetchImpl,
        collectedAt,
      })
    );
  }

  const items = sourceResults.flatMap((result) => result.items);
  const success = sourceResults.filter((result) => result.status === "ok").length;
  const failed = sourceResults.length - success;

  const document = {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    generatedAt: collectedAt,
    sourceFeeds: sourceResults.map((result) => result.sourceFeed),
    items,
  };

  if (success > 0 && options.normalizedPath) {
    await writeJsonAtomic(options.normalizedPath, document);
  }

  return {
    sources: enabled.length,
    success,
    failed,
    itemCount: items.length,
    generatedAt: collectedAt,
    sourceResults,
    document,
  };
}

async function ingestOneSource({ source, rawDir, fetchImpl, collectedAt }) {
  try {
    const xml = await fetchText(source.url, { fetchImpl });
    if (rawDir) {
      const rawPath = path.join(rawDir, `${source.id}.xml`);
      await writeTextAtomic(rawPath, xml.endsWith("\n") ? xml : `${xml}\n`);
    }

    const parsed = parseFeedXml(xml);
    const items = parsed.items.map((item) =>
      normalizeWebItem(item, source, collectedAt)
    );
    assertUniqueItemIds(items);

    return {
      status: "ok",
      source,
      items,
      sourceFeed: {
        provider: source.id,
        type: WEB_SOURCE_TYPE,
        url: source.url,
        sourceGeneratedAt: toIso8601OrNull(parsed.updatedAt),
        itemCount: items.length,
        status: "ok",
      },
    };
  } catch (error) {
    const message = publicErrorMessage(error);
    return {
      status: "error",
      source,
      items: [],
      error: message,
      sourceFeed: {
        provider: source.id,
        type: WEB_SOURCE_TYPE,
        url: source.url,
        sourceGeneratedAt: null,
        itemCount: 0,
        status: "error",
        error: message,
      },
    };
  }
}

function assertUniqueItemIds(items) {
  const seen = new Map();
  items.forEach((item, index) => {
    const previous = seen.get(item.id);
    if (previous !== undefined) {
      throw new ValidationError(
        `Duplicate stable id "${item.id}" at items[${previous}] and items[${index}]`
      );
    }
    seen.set(item.id, index);
  });
}

function publicErrorMessage(error) {
  const message = error && error.message ? String(error.message) : String(error);
  return message.split("\n")[0].slice(0, 300);
}

function nonempty(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}
