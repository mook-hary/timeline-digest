import { ValidationError } from "../lib/errors.js";
import { validateNormalizedDocument } from "./news-pool.js";
import { copyRepresentative, copyScores } from "./select-document.js";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function validateSelectedDigestInput(selected) {
  if (!isPlainObject(selected)) {
    throw new ValidationError("Selected document must be an object");
  }
  if (selected.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported selected schemaVersion: ${selected.schemaVersion}`
    );
  }
  if (!Array.isArray(selected.selected)) {
    throw new ValidationError("Selected document selected must be an array");
  }
  const seen = new Set();
  for (const [index, entry] of selected.selected.entries()) {
    if (!isPlainObject(entry)) {
      throw new ValidationError(`selected[${index}] must be an object`);
    }
    if (typeof entry.clusterId !== "string" || entry.clusterId.trim() === "") {
      throw new ValidationError(`selected[${index}] is missing clusterId`);
    }
    if (seen.has(entry.clusterId)) {
      throw new ValidationError(`duplicate selected clusterId ${entry.clusterId}`);
    }
    seen.add(entry.clusterId);
    if (!Number.isInteger(entry.rank) || entry.rank < 1) {
      throw new ValidationError(`selected[${index}] rank must be a positive integer`);
    }
  }
  return selected;
}

export function validateEvaluatedDigestInput(evaluated) {
  if (!isPlainObject(evaluated)) {
    throw new ValidationError("Evaluated document must be an object");
  }
  if (evaluated.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported evaluated schemaVersion: ${evaluated.schemaVersion}`
    );
  }
  if (!Array.isArray(evaluated.clusters) || evaluated.clusters.length < 1) {
    throw new ValidationError("Evaluated document clusters must be a non-empty array");
  }
  return evaluated;
}

function sourceKey(item) {
  const url = item?.source?.url;
  if (typeof url === "string" && url.trim() !== "") return `url:${url}`;
  return `id:${item.id}`;
}

function compareSourceItems(left, right) {
  const leftProvider = left.source?.provider || "";
  const rightProvider = right.source?.provider || "";
  if (leftProvider < rightProvider) return -1;
  if (leftProvider > rightProvider) return 1;
  const leftUrl = left.source?.url || "";
  const rightUrl = right.source?.url || "";
  if (leftUrl < rightUrl) return -1;
  if (leftUrl > rightUrl) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function buildDigestSources(members, representativeItemId) {
  const representative =
    members.find((item) => item.id === representativeItemId) || members[0];
  const rest = members
    .filter((item) => item.id !== representative?.id)
    .sort(compareSourceItems);
  const ordered = [representative, ...rest].filter(Boolean);
  const seen = new Set();
  const sources = [];
  for (const item of ordered) {
    const key = sourceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      provider: item.source?.provider ?? null,
      type: item.source?.type ?? null,
      url: item.source?.url ?? null,
      title: item.title ?? null,
    });
  }
  return sources;
}

function representativeAsItem(representative) {
  return {
    id: representative.itemId,
    title: representative.title,
    summary: representative.summary,
    category: representative.category,
    publishedAt: representative.publishedAt,
    source: {
      type: representative.source?.type ?? null,
      provider: representative.source?.provider ?? null,
      url: representative.source?.url ?? null,
    },
  };
}

export function joinDigestRecords({ selected, evaluated, pool }) {
  const selectedDoc = validateSelectedDigestInput(selected);
  const evaluatedDoc = validateEvaluatedDigestInput(evaluated);
  const poolDoc = validateNormalizedDocument(pool, "news-pool");

  const evaluatedById = new Map(
    evaluatedDoc.clusters.map((cluster) => [cluster.clusterId, cluster])
  );
  const itemsById = new Map(poolDoc.items.map((item) => [item.id, item]));
  const rejectedIds = new Set(
    (selectedDoc.rejected || []).map((entry) => entry.clusterId)
  );

  const entries = [...selectedDoc.selected].sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    if (left.clusterId < right.clusterId) return -1;
    if (left.clusterId > right.clusterId) return 1;
    return 0;
  });

  return entries.map((entry) => {
    if (rejectedIds.has(entry.clusterId)) {
      throw new ValidationError(
        `selected cluster ${entry.clusterId} is also listed as rejected`
      );
    }
    const evaluatedCluster = evaluatedById.get(entry.clusterId);
    if (!evaluatedCluster) {
      throw new ValidationError(
        `selected cluster ${entry.clusterId} is missing from evaluated input`
      );
    }
    if (!Array.isArray(evaluatedCluster.itemIds) || evaluatedCluster.itemIds.length < 1) {
      throw new ValidationError(`evaluated cluster ${entry.clusterId} has no itemIds`);
    }
    const members = evaluatedCluster.itemIds.map((itemId) => {
      const item = itemsById.get(itemId);
      if (!item) {
        throw new ValidationError(
          `news-pool is missing item ${itemId} for cluster ${entry.clusterId}`
        );
      }
      return item;
    });
    const representativeCopy = copyRepresentative(entry.representative);
    const representativeItem =
      members.find((item) => item.id === representativeCopy?.itemId) ||
      representativeAsItem(representativeCopy);

    return {
      rank: entry.rank,
      clusterId: entry.clusterId,
      lane: entry.lane,
      topicGroup: entry.topicGroup,
      selectionReason: entry.selectionReason,
      representative: representativeCopy,
      publishedAt: representativeCopy?.publishedAt ?? null,
      scores: copyScores(entry.scores),
      baseScore: entry.baseScore,
      members,
      representativeItem,
      signals: {
        itemCount: evaluatedCluster.signals?.itemCount ?? members.length,
        providers: [...(evaluatedCluster.signals?.providers || [])],
      },
      sources: buildDigestSources(members, representativeCopy?.itemId),
      originalItemIds: evaluatedCluster.itemIds.slice(),
    };
  });
}
