import { ValidationError } from "../lib/errors.js";
import { copyRepresentative, copyScores } from "./select-document.js";

export const DIGEST_SCHEMA_VERSION = 1;

export function digestDateOf(iso, timeZone = "Asia/Tokyo") {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return String(iso).slice(0, 10);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function fallbackDigestText(record) {
  return {
    headline: record.representative?.title ?? null,
    summary: record.representative?.summary ?? null,
    whyItMatters: null,
  };
}

export function buildDigestItem(record, generation, text) {
  return {
    rank: record.rank,
    displayOrder: record.rank,
    clusterId: record.clusterId,
    lane: record.lane,
    topicGroup: record.topicGroup,
    selectionReason: record.selectionReason,
    representative: copyRepresentative(record.representative),
    publishedAt: record.publishedAt,
    scores: copyScores(record.scores),
    baseScore: record.baseScore,
    headline: text.headline,
    summary: text.summary,
    whyItMatters: text.whyItMatters,
    sources: record.sources.map((source) => ({ ...source })),
    status: generation.status,
    generation: {
      model: generation.model ?? null,
      generatorVersion: generation.generatorVersion,
      cacheHit: Boolean(generation.cacheHit),
      error: generation.error ?? null,
      errorDetail: generation.errorDetail ?? null,
    },
  };
}

export function buildDigestReviewItem(item) {
  return {
    rank: item.rank,
    clusterId: item.clusterId,
    status: item.status,
    originalTitle: item.representative?.title ?? null,
    originalSummary: item.representative?.summary ?? null,
    generatedHeadline: item.headline,
    generatedSummary: item.summary,
    whyItMatters: item.whyItMatters,
    representativeProvider: item.representative?.source?.provider ?? null,
    representativeUrl: item.representative?.source?.url ?? null,
    sources: item.sources.map((source) => ({ ...source })),
    generation: { ...item.generation },
    errorDetail: item.generation?.errorDetail ?? null,
  };
}

export function countDigestStatuses(items) {
  const counts = { ok: 0, fallback: 0, failed: 0, ungenerated: 0 };
  for (const item of items) {
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
    else counts.fallback += 1;
  }
  return counts;
}

export function buildDigestDocument({
  generatedAt,
  sourceSelection,
  digestConfig,
  items,
  stats,
}) {
  const statusCounts = countDigestStatuses(items);
  return {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    generatedAt,
    digestDate: digestDateOf(generatedAt),
    sourceSelection: {
      path: sourceSelection.path,
      generatedAt: sourceSelection.generatedAt ?? null,
    },
    generator: {
      model: digestConfig.model,
      generatorVersion: digestConfig.generatorVersion,
    },
    stats: {
      inputSelected: stats.inputSelected,
      ok: statusCounts.ok,
      fallback: statusCounts.fallback,
      failed: statusCounts.failed,
      ungenerated: statusCounts.ungenerated,
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses,
      estimatedAiRequests: stats.estimatedAiRequests,
      judgeCalls: stats.judgeCalls,
      requestLimit: stats.requestLimit,
      dryRun: stats.dryRun,
      applyAi: stats.applyAi,
    },
    items,
  };
}

export function buildDigestReviewDocument({ generatedAt, items }) {
  return {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    generatedAt,
    itemCount: items.length,
    items: items.map((item) => buildDigestReviewItem(item)),
  };
}

export function assertDigestPartition(records, items) {
  if (records.length !== items.length) {
    throw new ValidationError(
      `digest item count ${items.length} does not match selected ${records.length}`
    );
  }
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].clusterId !== items[index].clusterId) {
      throw new ValidationError("digest clusterId order does not match selected rank order");
    }
    if (items[index].rank !== records[index].rank) {
      throw new ValidationError("digest rank changed");
    }
    if (items[index].displayOrder !== items[index].rank) {
      throw new ValidationError("displayOrder must equal rank");
    }
  }
}
