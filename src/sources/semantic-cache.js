import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-write.js";

export const SEMANTIC_CACHE_SCHEMA_VERSION = 1;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function itemContentHash(item) {
  return sha256(
    [
      item.id,
      item.title ?? "",
      item.summary ?? "",
      item.category ?? "",
      item.publishedAt ?? "",
    ].join("\u001f")
  );
}

export function semanticCacheKey(itemA, itemB, options) {
  const [left, right] =
    itemA.id < itemB.id ? [itemA, itemB] : [itemB, itemA];
  return sha256(
    [
      left.id,
      right.id,
      itemContentHash(left),
      itemContentHash(right),
      options.model,
      options.judgeVersion,
    ].join("\u001f")
  );
}

export function emptySemanticCache() {
  return {
    schemaVersion: SEMANTIC_CACHE_SCHEMA_VERSION,
    entries: {},
  };
}

export async function loadSemanticCache(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(text);
    if (!data || data.schemaVersion !== 1 || typeof data.entries !== "object") {
      return emptySemanticCache();
    }
    return {
      schemaVersion: 1,
      entries: data.entries || {},
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return emptySemanticCache();
    return emptySemanticCache();
  }
}

export async function saveSemanticCache(filePath, cache) {
  return writeJsonAtomic(filePath, {
    schemaVersion: SEMANTIC_CACHE_SCHEMA_VERSION,
    entries: cache.entries,
  });
}

export function cacheEntryFromJudgment(candidate, left, right, judgment, options) {
  const [itemA, itemB] =
    left.id < right.id ? [left, right] : [right, left];
  return {
    itemA: itemA.id,
    itemB: itemB.id,
    contentHashA: itemContentHash(itemA),
    contentHashB: itemContentHash(itemB),
    model: options.model,
    judgeVersion: options.judgeVersion,
    relationship: judgment.relationship,
    confidence: judgment.confidence,
    reason: judgment.reason,
    judgedAt: options.judgedAt,
    status: "ok",
  };
}
