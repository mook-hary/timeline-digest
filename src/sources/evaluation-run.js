import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "../config.js";
import { writeJsonAtomic } from "../lib/atomic-write.js";
import { ValidationError } from "../lib/errors.js";
import { validateNormalizedDocument } from "./news-pool.js";
import { assertClusterInvariants } from "./news-clusters.js";
import { loadEvaluationConfig } from "./evaluation-config.js";
import {
  buildEvaluatedCluster,
  validateEvaluatedClusters,
  validateSemanticEvaluationInput,
} from "./evaluation-clusters.js";

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

export async function runEvaluationPipeline(options = {}) {
  const dryRun = options.dryRun === true;
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
  const clusters = semantic.clusters.map((cluster) =>
    buildEvaluatedCluster(cluster, itemsById, evaluationConfig.weights)
  );
  validateEvaluatedClusters(pool.items, clusters, semantic.clusters);

  const generatedAt =
    typeof options.now === "function" ? options.now() : new Date().toISOString();
  const sourceSemanticPath =
    options.sourceSemanticPath ||
    (semanticPath
      ? path.relative(options.rootDir || ROOT_DIR, semanticPath)
      : "data/processed/news-semantic.json");

  const stats = {
    itemCount: pool.items.length,
    clusterCount: clusters.length,
    evaluatedCount: 0,
    unevaluatedCount: clusters.length,
  };

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
    breakdown: clusterBreakdown(clusters),
    dryRun,
  };
}
