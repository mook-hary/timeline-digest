import { EVALUATION_SCORE_AXES } from "../lib/evaluation-score.js";
import { ValidationError } from "../lib/errors.js";
import { SELECT_REJECTION_REASONS, SELECT_SELECTION_REASONS } from "./select-config.js";

export const SELECT_SCHEMA_VERSION = 1;

export function copyScores(scores) {
  const copied = {};
  for (const axis of EVALUATION_SCORE_AXES) {
    copied[axis] = scores && scores[axis] != null ? scores[axis] : null;
  }
  return copied;
}

export function copyRepresentative(representative) {
  if (representative == null || typeof representative !== "object") return null;
  return {
    itemId: representative.itemId ?? null,
    title: representative.title ?? null,
    summary: representative.summary ?? null,
    category: representative.category ?? null,
    publishedAt: representative.publishedAt ?? null,
    source: {
      type: representative.source?.type ?? null,
      provider: representative.source?.provider ?? null,
      url: representative.source?.url ?? null,
    },
  };
}

export function validateEvaluatedSelectInput(evaluated) {
  if (evaluated == null || typeof evaluated !== "object" || Array.isArray(evaluated)) {
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
  const seen = new Set();
  for (const [index, cluster] of evaluated.clusters.entries()) {
    if (!cluster || typeof cluster !== "object") {
      throw new ValidationError(`evaluated clusters[${index}] must be an object`);
    }
    if (typeof cluster.clusterId !== "string" || cluster.clusterId.trim() === "") {
      throw new ValidationError(`evaluated clusters[${index}] is missing clusterId`);
    }
    if (seen.has(cluster.clusterId)) {
      throw new ValidationError(`duplicate evaluated clusterId ${cluster.clusterId}`);
    }
    seen.add(cluster.clusterId);
    if (!Array.isArray(cluster.itemIds) || cluster.itemIds.length < 1) {
      throw new ValidationError(`evaluated cluster ${cluster.clusterId} has no itemIds`);
    }
  }
  return evaluated;
}

export function validateSemanticSelectInput(semantic) {
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
  if (semantic.judgments != null && !Array.isArray(semantic.judgments)) {
    throw new ValidationError("Semantic document judgments must be an array");
  }
  return semantic;
}

export function assertSelectPartition(records, selected, rejected) {
  if (selected.length + rejected.length !== records.length) {
    throw new ValidationError(
      `select partition ${selected.length}+${rejected.length} does not match ${records.length} clusters`
    );
  }
  const ids = new Set();
  for (const record of [...selected, ...rejected]) {
    const clusterId = record.cluster.clusterId;
    if (ids.has(clusterId)) {
      throw new ValidationError(`duplicate cluster in select output: ${clusterId}`);
    }
    ids.add(clusterId);
  }
  for (const record of selected) {
    if (!SELECT_SELECTION_REASONS.includes(record.selectionReason)) {
      throw new ValidationError(`invalid selectionReason: ${record.selectionReason}`);
    }
  }
  for (const record of rejected) {
    if (!SELECT_REJECTION_REASONS.includes(record.rejectionReason)) {
      throw new ValidationError(`invalid rejectionReason: ${record.rejectionReason}`);
    }
  }
}

export function assertMembershipUnchanged(records) {
  for (const record of records) {
    const original = record.originalItemIds;
    const current = record.cluster.itemIds;
    if (original.length !== current.length) {
      throw new ValidationError(`itemIds changed for ${record.cluster.clusterId}`);
    }
    for (let index = 0; index < original.length; index += 1) {
      if (original[index] !== current[index]) {
        throw new ValidationError(`itemIds changed for ${record.cluster.clusterId}`);
      }
    }
  }
}

export function buildSelectedEntry(record) {
  return {
    rank: record.rank,
    clusterId: record.cluster.clusterId,
    lane: record.lane,
    lanes: [...record.lanes],
    topicGroup: record.topicGroup,
    relatedGroupId: record.relatedGroupId,
    editorialRole: record.editorialRole,
    editorialPriority: record.editorialPriority,
    selectionReason: record.selectionReason,
    selectionReasons: [...record.selectionReasons],
    representative: copyRepresentative(record.cluster.representative),
    scores: copyScores(record.cluster.scores),
    baseScore: record.cluster.baseScore,
  };
}

export function buildRejectedEntry(record) {
  return {
    clusterId: record.cluster.clusterId,
    rejectionReason: record.rejectionReason,
    rejectionDetail: record.rejectionDetail,
    lane: record.lane,
    topicGroup: record.topicGroup,
    relatedGroupId: record.relatedGroupId,
    editorialRole: record.editorialRole,
    scores: copyScores(record.cluster.scores),
    baseScore: record.cluster.baseScore ?? null,
  };
}

export function buildReviewDocument({ generatedAt, groups, selectedIds }) {
  const multi = groups.filter((group) => group.members.length > 1);
  return {
    schemaVersion: SELECT_SCHEMA_VERSION,
    generatedAt,
    relatedGroupCount: groups.length,
    multiClusterRelatedGroupCount: multi.length,
    groups: multi.map((group) => {
      const main = group.members.find((record) => record.editorialRole === "main-event");
      return {
        relatedGroupId: group.relatedGroupId,
        memberClusterIds: group.members.map((record) => record.cluster.clusterId),
        members: group.members.map((record) => ({
          clusterId: record.cluster.clusterId,
          title: record.cluster.representative?.title ?? null,
          editorialRole: record.editorialRole,
          selected: selectedIds.has(record.cluster.clusterId),
        })),
        evidence: group.evidence.map((entry) => ({
          kind: entry.kind,
          detail: entry.detail || null,
          clusterA: entry.clusterA,
          clusterB: entry.clusterB,
          itemA: entry.itemA || null,
          itemB: entry.itemB || null,
          titleSimilarity: entry.titleSimilarity ?? null,
          sharedCjkRun: entry.sharedCjkRun || null,
          sharedTerms: entry.sharedTerms || null,
          longSharedTerms: entry.longSharedTerms || null,
          sharedProperNouns: entry.sharedProperNouns || null,
          confidence: entry.confidence ?? null,
        })),
        selectedMainEvent: main
          ? {
              clusterId: main.cluster.clusterId,
              title: main.cluster.representative?.title ?? null,
            }
          : null,
        rejectedRelated: group.members
          .filter((record) => record.editorialRole === "related")
          .map((record) => ({
            clusterId: record.cluster.clusterId,
            title: record.cluster.representative?.title ?? null,
          })),
      };
    }),
  };
}
