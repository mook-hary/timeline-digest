import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-write.js";

export const EVALUATION_CACHE_SCHEMA_VERSION = 1;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function evaluationContentHash(payloadInput) {
  return sha256(typeof payloadInput === "string" ? payloadInput : JSON.stringify(payloadInput));
}

export function evaluationCacheKey({ clusterId, contentHash, model, evaluatorVersion }) {
  return sha256([clusterId, contentHash, model, evaluatorVersion].join("\u001f"));
}

export function emptyEvaluationCache() {
  return {
    schemaVersion: EVALUATION_CACHE_SCHEMA_VERSION,
    entries: {},
  };
}

export async function loadEvaluationCache(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(text);
    if (!data || data.schemaVersion !== 1 || typeof data.entries !== "object") {
      return emptyEvaluationCache();
    }
    return {
      schemaVersion: 1,
      entries: data.entries || {},
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyEvaluationCache();
    return emptyEvaluationCache();
  }
}

export async function saveEvaluationCache(filePath, cache) {
  return writeJsonAtomic(filePath, {
    schemaVersion: EVALUATION_CACHE_SCHEMA_VERSION,
    entries: cache.entries,
  });
}

export function cacheEntryFromEvaluation(cluster, judgment, options) {
  return {
    clusterId: cluster.clusterId,
    contentHash: options.contentHash,
    model: options.model,
    evaluatorVersion: options.evaluatorVersion,
    scores: { ...judgment.scores },
    reason: judgment.reason,
    judgedAt: options.judgedAt,
    status: "ok",
  };
}
