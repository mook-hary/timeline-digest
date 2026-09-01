import fs from "node:fs/promises";
import path from "node:path";
import { evaluateClusterJudgment } from "../ai/evaluation-judge.js";
import { buildEvaluationResponsesPayload } from "../ai/evaluation-prompt.js";
import { ROOT_DIR } from "../config.js";
import { writeJsonAtomic } from "../lib/atomic-write.js";
import { validateRequestLimit } from "../lib/cli-limit.js";
import { AiError, ValidationError } from "../lib/errors.js";
import {
  applyEvaluationResult,
  buildEvaluatedCluster,
  selectSupportingItems,
  sortEvaluationTargets,
  validateEvaluatedClusters,
  validateSemanticEvaluationInput,
} from "./evaluation-clusters.js";
import { loadEvaluationConfig } from "./evaluation-config.js";
import {
  cacheEntryFromEvaluation,
  evaluationCacheKey,
  evaluationContentHash,
  loadEvaluationCache,
  saveEvaluationCache,
} from "./evaluation-cache.js";
import { assertClusterInvariants } from "./news-clusters.js";
import { validateNormalizedDocument } from "./news-pool.js";

export const EVALUATION_SCHEMA_VERSION = 1;

async function readJsonFile(filePath, missingLabel) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new ValidationError(`${missingLabel} is missing: ${filePath}`);
    }
    throw new ValidationError(`Failed to read ${missingLabel}: ${error.message}`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`${missingLabel} is not valid JSON`, { cause: error });
  }
}

function resolvePoolPath(semantic, options) {
  if (options.poolPath) return options.poolPath;
  const relative = semantic.sourcePool && semantic.sourcePool.path;
  if (typeof relative === "string" && relative.trim() !== "") {
    return path.resolve(options.rootDir || ROOT_DIR, relative);
  }
  return null;
}

export function clusterBreakdown(clusters) {
  const singletonCount = clusters.filter((cluster) => cluster.itemIds.length === 1).length;
  const sourceTypes = {};
  const providers = {};
  for (const cluster of clusters) {
    const key = (cluster.signals.sourceTypes || []).join(",") || "(none)";
    sourceTypes[key] = (sourceTypes[key] || 0) + 1;
    for (const provider of cluster.signals.providers || []) {
      providers[provider] = (providers[provider] || 0) + 1;
    }
  }
  return {
    singletonCount,
    multiItemClusterCount: clusters.length - singletonCount,
    sourceTypes,
    providers,
  };
}

function countStatuses(clusters) {
  const counts = {
    evaluated: 0,
    failed: 0,
    unjudged: 0,
    unevaluated: 0,
  };
  for (const cluster of clusters) {
    if (cluster.status === "evaluated") counts.evaluated += 1;
    else if (cluster.status === "failed") counts.failed += 1;
    else if (cluster.status === "unjudged") counts.unjudged += 1;
    else counts.unevaluated += 1;
  }
  return counts;
}

export function clusterEvaluationPayload(cluster, itemsById, evaluationConfig) {
  const members = cluster.itemIds.map((itemId) => itemsById.get(itemId));
  const representative = members.find(
    (item) => item.id === cluster.representative.itemId
  );
  const supportingItems = selectSupportingItems(
    members,
    representative,
    evaluationConfig.maxItemsPerCluster
  );
  const payload = buildEvaluationResponsesPayload({
    model: evaluationConfig.model,
    representative,
    signals: cluster.signals,
    supportingItems,
    clipChars: evaluationConfig.summaryClipChars,
  });
  return {
    payload,
    contentHash: evaluationContentHash(payload.input),
  };
}

export async function runEvaluationPipeline(options = {}) {
  const dryRun = options.dryRun === true;
  const applyAi = options.applyAi === true;
  const requestLimit = validateRequestLimit(options.requestLimit);
  const evaluationConfig =
    options.evaluationConfig ||
    (await loadEvaluationConfig(options.evaluationConfigPath));

  const semanticPath = options.semanticPath;
  const semantic = options.semantic
    ? validateSemanticEvaluationInput(options.semantic)
    : validateSemanticEvaluationInput(
        await readJsonFile(semanticPath, "Semantic document")
      );

  let pool;
  if (options.pool) {
    pool = validateNormalizedDocument(options.pool, "news-pool");
  } else {
    const poolPath = resolvePoolPath(semantic, options);
    if (!poolPath) {
      throw new ValidationError("News pool path is missing");
    }
    pool = validateNormalizedDocument(
      await readJsonFile(poolPath, "News pool"),
      "news-pool"
    );
  }

  assertClusterInvariants(pool.items, semantic.clusters);

  const itemsById = new Map(pool.items.map((item) => [item.id, item]));
  const foundation = semantic.clusters.map((cluster) =>
    buildEvaluatedCluster(cluster, itemsById, evaluationConfig.weights)
  );
  validateEvaluatedClusters(pool.items, foundation, semantic.clusters);

  const evaluationOrder = sortEvaluationTargets(foundation);
  const cachePath = options.cachePath;
  const cache = cachePath
    ? await loadEvaluationCache(cachePath)
    : { schemaVersion: 1, entries: {} };

  let cacheHits = 0;
  let cacheMisses = 0;
  let judgeCalls = 0;
  let cacheDirty = false;
  const generatedAt =
    typeof options.now === "function" ? options.now() : new Date().toISOString();

  const clustersById = new Map(foundation.map((cluster) => [cluster.clusterId, cluster]));

  if (applyAi) {
    if (typeof options.evaluator !== "function") {
      throw new AiError("Evaluation judge is not configured");
    }

    for (const target of evaluationOrder) {
      const { payload, contentHash } = clusterEvaluationPayload(
        target,
        itemsById,
        evaluationConfig
      );
      const key = evaluationCacheKey({
        clusterId: target.clusterId,
        contentHash,
        model: evaluationConfig.model,
        evaluatorVersion: evaluationConfig.evaluatorVersion,
      });
      const cached = cache.entries[key];
      if (cached && cached.status === "ok") {
        cacheHits += 1;
        clustersById.set(
          target.clusterId,
          applyEvaluationResult(
            target,
            {
              status: "ok",
              scores: cached.scores,
              reason: cached.reason,
              error: null,
              errorDetail: null,
            },
            {
              model: cached.model,
              evaluatorVersion: cached.evaluatorVersion,
              cacheHit: true,
              weights: evaluationConfig.weights,
            }
          )
        );
        continue;
      }

      cacheMisses += 1;
      if (requestLimit != null && judgeCalls >= requestLimit) {
        clustersById.set(
          target.clusterId,
          applyEvaluationResult(
            target,
            { status: "unjudged", error: null, errorDetail: null },
            {
              model: evaluationConfig.model,
              evaluatorVersion: evaluationConfig.evaluatorVersion,
              cacheHit: false,
              weights: evaluationConfig.weights,
            }
          )
        );
        continue;
      }

      judgeCalls += 1;
      const judged = await evaluateClusterJudgment(payload, options.evaluator);
      if (judged.status === "ok") {
        cache.entries[key] = cacheEntryFromEvaluation(target, judged, {
          contentHash,
          model: evaluationConfig.model,
          evaluatorVersion: evaluationConfig.evaluatorVersion,
          judgedAt: generatedAt,
        });
        cacheDirty = true;
      }
      clustersById.set(
        target.clusterId,
        applyEvaluationResult(target, judged, {
          model: evaluationConfig.model,
          evaluatorVersion: evaluationConfig.evaluatorVersion,
          cacheHit: false,
          weights: evaluationConfig.weights,
        })
      );
    }
  } else {
    for (const target of evaluationOrder) {
      const { contentHash } = clusterEvaluationPayload(
        target,
        itemsById,
        evaluationConfig
      );
      const key = evaluationCacheKey({
        clusterId: target.clusterId,
        contentHash,
        model: evaluationConfig.model,
        evaluatorVersion: evaluationConfig.evaluatorVersion,
      });
      if (cache.entries[key] && cache.entries[key].status === "ok") {
        cacheHits += 1;
      }
    }
    cacheMisses = Math.max(0, foundation.length - cacheHits);
  }

  if (applyAi && cacheDirty && cachePath) {
    await saveEvaluationCache(cachePath, cache);
  }

  const clusters = foundation.map((cluster) => clustersById.get(cluster.clusterId));
  validateEvaluatedClusters(pool.items, clusters, semantic.clusters);

  const statuses = countStatuses(clusters);
  const stats = {
    itemCount: pool.items.length,
    clusterCount: clusters.length,
    evaluatedCount: statuses.evaluated,
    unevaluatedCount: statuses.unevaluated + statuses.unjudged,
    failed: statuses.failed,
    unjudged: statuses.unjudged,
    judgedCount: applyAi ? statuses.evaluated + statuses.failed : 0,
    judgeCalls,
    requestLimit,
    cacheHits,
    cacheMisses,
    estimatedAiRequests: applyAi ? judgeCalls : cacheMisses,
    dryRun,
  };

  const sourceSemanticPath =
    options.sourceSemanticPath ||
    (semanticPath
      ? path.relative(options.rootDir || ROOT_DIR, semanticPath)
      : "data/processed/news-semantic.json");

  const document = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    generatedAt,
    sourceSemantic: {
      path: sourceSemanticPath,
      generatedAt: semantic.generatedAt || null,
    },
    stats,
    clusters,
  };

  if (!dryRun && options.outputPath) {
    await writeJsonAtomic(options.outputPath, document);
  }

  return {
    document,
    stats,
    clusters,
    evaluationOrder,
    breakdown: clusterBreakdown(clusters),
    dryRun,
    judgeCalls,
  };
}
