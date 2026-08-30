import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "../config.js";
import { writeJsonAtomic } from "../lib/atomic-write.js";
import { AiError, ValidationError } from "../lib/errors.js";
import { judgeSemanticPair } from "../ai/semantic-judge.js";
import {
  assertClusterInvariants,
  detectRelationships,
} from "./news-clusters.js";
import { validateNormalizedDocument } from "./news-pool.js";
import {
  cacheEntryFromJudgment,
  loadSemanticCache,
  saveSemanticCache,
  semanticCacheKey,
} from "./semantic-cache.js";
import { generateSemanticCandidates } from "./semantic-candidates.js";
import { buildSemanticClusters } from "./semantic-clusters.js";

export const SEMANTIC_SCHEMA_VERSION = 1;

function pairIds(left, right) {
  return left < right ? [left, right] : [right, left];
}

async function readNewsPool(poolPath) {
  let text;
  try {
    text = await fs.readFile(poolPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new ValidationError(`News pool is missing: ${poolPath}`);
    }
    throw new ValidationError(`Failed to read news pool: ${error.message}`, {
      cause: error,
    });
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("News pool is not valid JSON", { cause: error });
  }
  return validateNormalizedDocument(document, "news-pool");
}

function itemsById(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function countJudgments(judgments) {
  const counts = {
    sameEvent: 0,
    relatedEvent: 0,
    differentEvent: 0,
    failed: 0,
    unjudged: 0,
  };
  for (const judgment of judgments) {
    if (judgment.status === "unjudged") {
      counts.unjudged += 1;
      continue;
    }
    if (judgment.status !== "ok") {
      counts.failed += 1;
      continue;
    }
    if (judgment.relationship === "same-event") counts.sameEvent += 1;
    if (judgment.relationship === "related-event") counts.relatedEvent += 1;
    if (judgment.relationship === "different-event") counts.differentEvent += 1;
  }
  return counts;
}

export function validateRequestLimit(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(
      "Invalid --limit. Use a positive integer (new AI requests, not cache hits)."
    );
  }
  return value;
}

function candidateToJudgment(candidate, judgment, model, judgeVersion) {
  const [itemA, itemB] = pairIds(candidate.itemA, candidate.itemB);
  return {
    itemA,
    itemB,
    candidateSignals: {
      candidateScore: candidate.candidateScore,
      titleSimilarity: candidate.titleSimilarity,
      tokenOverlap: candidate.tokenOverlap,
      sharedProperNouns: candidate.sharedProperNouns,
      hoursApart: candidate.hoursApart,
      sameHostname: candidate.sameHostname,
      sameCategory: candidate.sameCategory,
      differentProvider: candidate.differentProvider,
    },
    relationship: judgment.relationship,
    confidence: judgment.confidence,
    reason: judgment.reason,
    model,
    judgeVersion,
    status: judgment.status,
    error: judgment.error || null,
    errorDetail: judgment.errorDetail || null,
    cacheHit: Boolean(judgment.cacheHit),
  };
}

export async function runSemanticPipeline(options = {}) {
  const applyAi = options.applyAi === true;
  const requestLimit = validateRequestLimit(options.requestLimit);
  const semanticConfig = options.semanticConfig;
  const clusterConfig = options.clusterConfig;
  if (!semanticConfig || !clusterConfig) {
    throw new ValidationError("Semantic pipeline requires semantic and cluster config");
  }

  const pool = options.pool
    ? validateNormalizedDocument(options.pool, "news-pool")
    : await readNewsPool(options.poolPath);

  const generatedAt =
    typeof options.now === "function" ? options.now() : new Date().toISOString();
  const candidates = generateSemanticCandidates(
    pool.items,
    semanticConfig.candidate
  );
  const lookup = itemsById(pool.items);
  const detRelationships = detectRelationships(pool.items, clusterConfig);

  const cachePath = options.cachePath;
  const cache = cachePath
    ? await loadSemanticCache(cachePath)
    : { schemaVersion: 1, entries: {} };

  let cacheHits = 0;
  let cacheMisses = 0;
  let judgeCalls = 0;
  const judgments = [];
  let cacheDirty = false;

  if (applyAi) {
    if (typeof options.judge !== "function") {
      throw new AiError("Semantic judge is not configured");
    }

    for (const candidate of candidates) {
      const left = lookup.get(candidate.itemA);
      const right = lookup.get(candidate.itemB);
      const key = semanticCacheKey(left, right, {
        model: semanticConfig.model,
        judgeVersion: semanticConfig.judgeVersion,
      });
      const cached = cache.entries[key];
      if (cached && cached.status === "ok") {
        cacheHits += 1;
        judgments.push(
          candidateToJudgment(
            candidate,
            {
              status: "ok",
              relationship: cached.relationship,
              confidence: cached.confidence,
              reason: cached.reason,
              error: null,
              cacheHit: true,
            },
            cached.model,
            cached.judgeVersion
          )
        );
        continue;
      }

      cacheMisses += 1;
      if (requestLimit != null && judgeCalls >= requestLimit) {
        judgments.push(
          candidateToJudgment(
            candidate,
            {
              status: "unjudged",
              relationship: null,
              confidence: null,
              reason: null,
              error: null,
              cacheHit: false,
            },
            semanticConfig.model,
            semanticConfig.judgeVersion
          )
        );
        continue;
      }

      judgeCalls += 1;
      const judged = await judgeSemanticPair(left, right, { candidate }, options.judge);
      if (judged.status === "ok") {
        cache.entries[key] = cacheEntryFromJudgment(candidate, left, right, judged, {
          model: semanticConfig.model,
          judgeVersion: semanticConfig.judgeVersion,
          judgedAt: generatedAt,
        });
        cacheDirty = true;
      }
      judgments.push(
        candidateToJudgment(candidate, judged, semanticConfig.model, semanticConfig.judgeVersion)
      );
    }
  } else {
    cacheMisses = 0;
    for (const candidate of candidates) {
      const left = lookup.get(candidate.itemA);
      const right = lookup.get(candidate.itemB);
      const key = semanticCacheKey(left, right, {
        model: semanticConfig.model,
        judgeVersion: semanticConfig.judgeVersion,
      });
      if (cache.entries[key] && cache.entries[key].status === "ok") {
        cacheHits += 1;
      }
    }
  }

  if (applyAi && cacheDirty && cachePath) {
    await saveSemanticCache(cachePath, cache);
  }

  const judgmentCounts = countJudgments(judgments);
  const { clusters, conflicts } = applyAi
    ? buildSemanticClusters({
        items: pool.items,
        deterministicRelationships: detRelationships,
        clusterConfig,
        judgments,
      })
    : { clusters: [], conflicts: [] };

  if (applyAi) {
    assertClusterInvariants(pool.items, clusters);
  }

  const judgedCount = applyAi
    ? judgments.length - judgmentCounts.unjudged
    : 0;
  const stats = {
    itemCount: pool.items.length,
    candidateCount: candidates.length,
    judgedCount,
    judgeCalls,
    requestLimit,
    unjudged: judgmentCounts.unjudged,
    cacheHits,
    cacheMisses: applyAi ? cacheMisses : Math.max(0, candidates.length - cacheHits),
    estimatedAiRequests: applyAi
      ? judgeCalls
      : Math.max(0, candidates.length - cacheHits),
    sameEvent: judgmentCounts.sameEvent,
    relatedEvent: judgmentCounts.relatedEvent,
    differentEvent: judgmentCounts.differentEvent,
    failed: judgmentCounts.failed,
    clusterCount: applyAi ? clusters.length : null,
    conflictCount: conflicts.length,
    dryRun: !applyAi,
  };

  const sourcePoolPath =
    options.sourcePoolPath ||
    (options.poolPath
      ? path.relative(options.rootDir || ROOT_DIR, options.poolPath)
      : "data/normalized/news-pool.json");

  const document = {
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    generatedAt,
    sourcePool: {
      path: sourcePoolPath,
      generatedAt: pool.generatedAt,
    },
    deterministicClusters: {
      path: "data/processed/news-clusters.json",
      relationshipCount: detRelationships.length,
    },
    stats,
    candidates,
    judgments,
    conflicts,
    clusters,
  };

  if (!applyAi && options.candidatesPath) {
    await writeJsonAtomic(options.candidatesPath, {
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      generatedAt,
      sourcePool: document.sourcePool,
      stats: {
        itemCount: stats.itemCount,
        candidateCount: stats.candidateCount,
        cacheHits: stats.cacheHits,
        estimatedAiRequests: stats.estimatedAiRequests,
        dryRun: true,
      },
      candidates,
    });
  }

  if (applyAi && options.outputPath) {
    await writeJsonAtomic(options.outputPath, document);
  }

  return {
    stats,
    candidates,
    judgments,
    conflicts,
    clusters,
    document,
    judgeCalls,
  };
}
