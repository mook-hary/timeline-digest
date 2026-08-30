import { ValidationError } from "../lib/errors.js";
import {
  computeBaseScore,
  emptyEvaluationScores,
} from "../lib/evaluation-score.js";
import { assertClusterInvariants } from "./news-clusters.js";

function nonemptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function parseTime(value) {
  if (value == null) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function compareNewerFirst(left, right) {
  const leftTime = parseTime(left);
  const rightTime = parseTime(right);
  if (leftTime != null && rightTime != null && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (leftTime != null && rightTime == null) return -1;
  if (leftTime == null && rightTime != null) return 1;
  return 0;
}

function comparePresentFirst(leftHas, rightHas) {
  if (leftHas === rightHas) return 0;
  return leftHas ? -1 : 1;
}

export function compareRepresentativeItems(left, right) {
  const published = compareNewerFirst(left.publishedAt, right.publishedAt);
  if (published !== 0) return published;
  const collected = compareNewerFirst(left.collectedAt, right.collectedAt);
  if (collected !== 0) return collected;
  const title = comparePresentFirst(
    nonemptyString(left.title),
    nonemptyString(right.title)
  );
  if (title !== 0) return title;
  const summary = comparePresentFirst(
    nonemptyString(left.summary),
    nonemptyString(right.summary)
  );
  if (summary !== 0) return summary;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function selectRepresentative(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError("Cannot select a representative from an empty cluster");
  }
  return [...items].sort(compareRepresentativeItems)[0];
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => nonemptyString(value)))].sort();
}

export function computeClusterSignals(items) {
  const urls = uniqueSorted(
    items.map((item) => (item.source && item.source.url) || "")
  );
  const providers = uniqueSorted(
    items.map((item) => (item.source && item.source.provider) || "")
  );
  const sourceTypes = uniqueSorted(
    items.map((item) => (item.source && item.source.type) || "")
  );
  return {
    itemCount: items.length,
    sourceCount: urls.length,
    sourceDiversity: providers.length,
    sourceTypes,
    providers,
  };
}

export function validateSemanticClusterShape(cluster, index) {
  if (cluster == null || typeof cluster !== "object" || Array.isArray(cluster)) {
    throw new ValidationError(`semantic clusters[${index}] must be an object`);
  }
  const clusterId = cluster.id || cluster.clusterId;
  if (!nonemptyString(clusterId)) {
    throw new ValidationError(`semantic clusters[${index}] is missing cluster id`);
  }
  if (!Array.isArray(cluster.itemIds) || cluster.itemIds.length < 1) {
    throw new ValidationError(
      `semantic cluster "${clusterId}" must have at least one itemId`
    );
  }
  for (const [itemIndex, itemId] of cluster.itemIds.entries()) {
    if (!nonemptyString(itemId)) {
      throw new ValidationError(
        `semantic cluster "${clusterId}" itemIds[${itemIndex}] must be a non-empty string`
      );
    }
  }
  if (new Set(cluster.itemIds).size !== cluster.itemIds.length) {
    throw new ValidationError(
      `semantic cluster "${clusterId}" contains duplicate itemIds`
    );
  }
  return clusterId;
}

export function validateSemanticEvaluationInput(semantic) {
  if (semantic == null || typeof semantic !== "object" || Array.isArray(semantic)) {
    throw new ValidationError("Semantic document must be an object");
  }
  if (semantic.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported semantic schemaVersion: ${semantic.schemaVersion}`
    );
  }
  if (!Array.isArray(semantic.clusters)) {
    throw new ValidationError("Semantic document clusters must be an array");
  }
  semantic.clusters.forEach((cluster, index) => {
    validateSemanticClusterShape(cluster, index);
  });
  return semantic;
}

export function buildEvaluatedCluster(cluster, itemsById, weights) {
  const clusterId = cluster.id || cluster.clusterId;
  const items = cluster.itemIds.map((itemId) => {
    const item = itemsById.get(itemId);
    if (!item) {
      throw new ValidationError(
        `semantic cluster "${clusterId}" contains unknown item.id "${itemId}"`
      );
    }
    return item;
  });
  const representativeItem = selectRepresentative(items);
  if (!cluster.itemIds.includes(representativeItem.id)) {
    throw new ValidationError(
      `representative ${representativeItem.id} is not in cluster "${clusterId}"`
    );
  }
  const scores = emptyEvaluationScores();
  return {
    clusterId,
    itemIds: cluster.itemIds.slice(),
    representative: {
      itemId: representativeItem.id,
      title: representativeItem.title ?? null,
      summary: representativeItem.summary ?? null,
      category: representativeItem.category ?? null,
      publishedAt: representativeItem.publishedAt ?? null,
      source: {
        type: representativeItem.source?.type ?? null,
        provider: representativeItem.source?.provider ?? null,
        url: representativeItem.source?.url ?? null,
      },
    },
    signals: computeClusterSignals(items),
    scores,
    baseScore: computeBaseScore(scores, weights),
    reason: null,
    status: "unevaluated",
  };
}

export function validateEvaluatedClusters(items, evaluated, originalClusters) {
  if (evaluated.length !== originalClusters.length) {
    throw new ValidationError(
      `Evaluated cluster count ${evaluated.length} does not match semantic cluster count ${originalClusters.length}`
    );
  }
  assertClusterInvariants(
    items,
    evaluated.map((cluster) => ({ itemIds: cluster.itemIds }))
  );
  const itemsById = new Map(items.map((item) => [item.id, item]));
  for (const cluster of evaluated) {
    if (!nonemptyString(cluster.clusterId)) {
      throw new ValidationError("Evaluated cluster is missing clusterId");
    }
    if (!cluster.itemIds.includes(cluster.representative.itemId)) {
      throw new ValidationError(
        `representative ${cluster.representative.itemId} is not in cluster "${cluster.clusterId}"`
      );
    }
    const members = cluster.itemIds.map((itemId) => itemsById.get(itemId));
    const expected = computeClusterSignals(members);
    if (
      cluster.signals.itemCount !== expected.itemCount ||
      cluster.signals.sourceCount !== expected.sourceCount ||
      cluster.signals.sourceDiversity !== expected.sourceDiversity ||
      JSON.stringify(cluster.signals.sourceTypes) !== JSON.stringify(expected.sourceTypes) ||
      JSON.stringify(cluster.signals.providers) !== JSON.stringify(expected.providers)
    ) {
      throw new ValidationError(
        `signals for cluster "${cluster.clusterId}" do not match cluster items`
      );
    }
  }
}
