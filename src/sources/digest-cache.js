import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-write.js";

export const DIGEST_CACHE_SCHEMA_VERSION = 1;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestContentHash(payloadInput) {
  return sha256(typeof payloadInput === "string" ? payloadInput : JSON.stringify(payloadInput));
}

export function digestCacheKey({ clusterId, contentHash, model, generatorVersion }) {
  return sha256([clusterId, contentHash, model, generatorVersion].join("\u001f"));
}

export function emptyDigestCache() {
  return {
    schemaVersion: DIGEST_CACHE_SCHEMA_VERSION,
    entries: {},
  };
}

export async function loadDigestCache(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(text);
    if (!data || data.schemaVersion !== 1 || typeof data.entries !== "object") {
      return emptyDigestCache();
    }
    return {
      schemaVersion: 1,
      entries: data.entries || {},
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyDigestCache();
    return emptyDigestCache();
  }
}

export async function saveDigestCache(filePath, cache) {
  return writeJsonAtomic(filePath, {
    schemaVersion: DIGEST_CACHE_SCHEMA_VERSION,
    entries: cache.entries,
  });
}

export function cacheEntryFromDigest(clusterId, judgment, options) {
  return {
    clusterId,
    contentHash: options.contentHash,
    model: options.model,
    generatorVersion: options.generatorVersion,
    headline: judgment.headline,
    summary: judgment.summary,
    whyItMatters: judgment.whyItMatters,
    generatedAt: options.generatedAt,
    status: "ok",
  };
}
