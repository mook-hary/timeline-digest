import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "../config.js";
import { writeJsonAtomic } from "../lib/atomic-write.js";
import { normalizeUrlForCompare } from "../lib/compare-url.js";
import {
  normalizeTitleForCompare,
  titleSimilarity,
} from "../lib/compare-title.js";
import { ValidationError } from "../lib/errors.js";
import { validateNormalizedDocument } from "./news-pool.js";
import {
  loadClusterConfig,
  RELATIONSHIP_TYPES,
} from "./cluster-config.js";

export const CLUSTER_SCHEMA_VERSION = 1;

const TYPE_ORDER = {
  "same-url": 0,
  "same-title": 1,
  "title-similarity": 2,
};

function pairIds(left, right) {
  return left < right ? [left, right] : [right, left];
}

function compareRelationships(a, b) {
  const typeDelta = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99);
  if (typeDelta !== 0) return typeDelta;
  if (a.itemA < b.itemA) return -1;
  if (a.itemA > b.itemA) return 1;
  if (a.itemB < b.itemB) return -1;
  if (a.itemB > b.itemB) return 1;
  return 0;
}

export function buildClusterId(itemIds) {
  const payload = [...itemIds].sort().join("\n");
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return `cluster:${digest}`;
}

function makeRelationship({ itemA, itemB, type, confidence, signals, score }) {
  const [left, right] = pairIds(itemA, itemB);
  const relationship = {
    itemA: left,
    itemB: right,
    type,
    confidence,
    signals: [...signals].sort(),
  };
  if (score != null) relationship.score = score;
  return relationship;
}

export function detectRelationships(items, clusterConfig) {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const relationships = [];

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const left = sorted[i];
      const right = sorted[j];

      const leftUrl = normalizeUrlForCompare(left.source?.url, {
        trackingParams: clusterConfig.url.trackingParams,
      });
      const rightUrl = normalizeUrlForCompare(right.source?.url, {
        trackingParams: clusterConfig.url.trackingParams,
      });
      if (leftUrl && rightUrl && leftUrl === rightUrl) {
        relationships.push(
          makeRelationship({
            itemA: left.id,
            itemB: right.id,
            type: "same-url",
            confidence: clusterConfig.confidence.sameUrl,
            signals: ["normalized-url"],
          })
        );
      }

      const leftTitle = normalizeTitleForCompare(left.title);
      const rightTitle = normalizeTitleForCompare(right.title);
      if (leftTitle && rightTitle && leftTitle === rightTitle) {
        relationships.push(
          makeRelationship({
            itemA: left.id,
            itemB: right.id,
            type: "same-title",
            confidence: clusterConfig.confidence.sameTitle,
            signals: ["normalized-title"],
          })
        );
        continue;
      }

      const similarity = titleSimilarity(left.title, right.title, {
        nGramSize: clusterConfig.title.nGramSize,
        minLength: clusterConfig.title.minLength,
      });
      if (
        similarity.comparable &&
        similarity.score >= clusterConfig.title.similarityThreshold
      ) {
        relationships.push(
          makeRelationship({
            itemA: left.id,
            itemB: right.id,
            type: "title-similarity",
            confidence: similarity.score,
            score: similarity.score,
            signals: [`char-${clusterConfig.title.nGramSize}-gram-dice`],
          })
        );
      }
    }
  }

  return relationships.sort(compareRelationships);
}

function shouldFormCluster(relationship, itemsById, clusterConfig) {
  if (relationship.type === "same-url") return true;
  if (relationship.type === "title-similarity") return true;
  if (relationship.type === "same-title") {
    const title = normalizeTitleForCompare(itemsById.get(relationship.itemA)?.title);
    return Boolean(
      title && title.length >= clusterConfig.title.sameTitleMinLength
    );
  }
  return false;
}

function createUnionFind(ids) {
  const parent = new Map();
  for (const id of ids) parent.set(id, id);

  function find(id) {
    let current = id;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  }

  return { find, union };
}

export function buildClusters(items, relationships, clusterConfig) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const { find, union } = createUnionFind(items.map((item) => item.id));

  for (const relationship of relationships) {
    if (shouldFormCluster(relationship, itemsById, clusterConfig)) {
      union(relationship.itemA, relationship.itemB);
    }
  }

  const groups = new Map();
  for (const item of items) {
    const root = find(item.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item.id);
  }

  const clusters = [];
  for (const itemIds of groups.values()) {
    const sortedIds = [...itemIds].sort();
    const idSet = new Set(sortedIds);
    const clusterRelationships = relationships.filter(
      (relationship) =>
        idSet.has(relationship.itemA) && idSet.has(relationship.itemB)
    );
    clusters.push({
      id: buildClusterId(sortedIds),
      itemIds: sortedIds,
      relationships: clusterRelationships.sort(compareRelationships),
    });
  }

  clusters.sort((a, b) => {
    if (b.itemIds.length !== a.itemIds.length) {
      return b.itemIds.length - a.itemIds.length;
    }
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return clusters;
}

export function assertClusterInvariants(items, clusters) {
  const poolIds = items.map((item) => item.id);
  const flattened = clusters.flatMap((cluster) => cluster.itemIds);

  if (flattened.length !== poolIds.length) {
    throw new ValidationError(
      `Cluster item count ${flattened.length} does not match pool item count ${poolIds.length}`
    );
  }

  if (new Set(poolIds).size !== poolIds.length) {
    throw new ValidationError("News pool contains duplicate item.id values");
  }

  if (new Set(flattened).size !== flattened.length) {
    throw new ValidationError("An item belongs to more than one cluster");
  }

  const poolSet = new Set(poolIds);
  for (const id of flattened) {
    if (!poolSet.has(id)) {
      throw new ValidationError(`Cluster contains unknown item.id "${id}"`);
    }
  }
}

function emptyRelationshipCounts() {
  return Object.fromEntries(RELATIONSHIP_TYPES.map((type) => [type, 0]));
}

export function buildClusterStats(items, clusters, relationships) {
  const byRelationshipType = emptyRelationshipCounts();
  for (const relationship of relationships) {
    byRelationshipType[relationship.type] =
      (byRelationshipType[relationship.type] || 0) + 1;
  }

  const multiItemClusterCount = clusters.filter(
    (cluster) => cluster.itemIds.length > 1
  ).length;

  return {
    itemCount: items.length,
    clusterCount: clusters.length,
    singletonCount: clusters.length - multiItemClusterCount,
    multiItemClusterCount,
    relationshipCount: relationships.length,
    byRelationshipType,
  };
}

export function buildClusterReview(items, clusters) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const multiItemClusters = clusters
    .filter((cluster) => cluster.itemIds.length > 1)
    .map((cluster) => ({
      id: cluster.id,
      itemCount: cluster.itemIds.length,
      items: cluster.itemIds.map((id) => {
        const item = itemsById.get(id);
        return {
          id,
          title: item ? item.title : null,
          provider: item ? item.source.provider : null,
          type: item ? item.source.type : null,
          url: item ? item.source.url : null,
        };
      }),
      relationships: cluster.relationships,
    }));

  return {
    schemaVersion: CLUSTER_SCHEMA_VERSION,
    multiItemClusters,
  };
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

  validateNormalizedDocument(document, "news-pool");
  return document;
}

export async function clusterNewsPool(options = {}) {
  const clusterConfig =
    options.clusterConfig ||
    (await loadClusterConfig(options.clusterConfigPath));

  const poolPath = options.poolPath;
  const pool = options.pool
    ? validateNormalizedDocument(options.pool, "news-pool")
    : await readNewsPool(poolPath);

  const relationships = detectRelationships(pool.items, clusterConfig);
  const clusters = buildClusters(pool.items, relationships, clusterConfig);
  assertClusterInvariants(pool.items, clusters);

  const generatedAt =
    typeof options.now === "function" ? options.now() : new Date().toISOString();
  const stats = buildClusterStats(pool.items, clusters, relationships);
  const sourcePoolPath =
    options.sourcePoolPath ||
    (poolPath ? path.relative(options.rootDir || ROOT_DIR, poolPath) : null);

  const document = {
    schemaVersion: CLUSTER_SCHEMA_VERSION,
    generatedAt,
    sourcePool: {
      path: sourcePoolPath,
      generatedAt: pool.generatedAt,
    },
    stats,
    relationships,
    clusters,
  };

  const review = {
    ...buildClusterReview(pool.items, clusters),
    generatedAt,
    sourcePool: document.sourcePool,
  };

  if (options.outputPath) {
    await writeJsonAtomic(options.outputPath, document);
  }
  if (options.reviewPath) {
    await writeJsonAtomic(options.reviewPath, review);
  }

  return {
    stats,
    document,
    review,
    outputPath: options.outputPath || null,
    reviewPath: options.reviewPath || null,
  };
}
