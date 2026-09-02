import { createHash } from "node:crypto";
import { titleSimilarity } from "../lib/compare-title.js";
import { extractProperNouns, extractTerms } from "./semantic-candidates.js";
import { computeMajorRank } from "./select-lanes.js";

function pairKey(left, right) {
  return left < right ? `${left}\u001f${right}` : `${right}\u001f${left}`;
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

function parseTime(value) {
  if (value == null || typeof value !== "string" || value.trim() === "") return null;
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

export function relatedGroupIdFor(clusterIds) {
  const sorted = [...clusterIds].sort();
  const digest = createHash("sha256").update(sorted.join("|")).digest("hex").slice(0, 16);
  return `rel:${digest}`;
}

export function longestSharedCjkRun(leftTitle, rightTitle) {
  const left = String(leftTitle || "");
  const right = String(rightTitle || "");
  const runs = left.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu) || [];
  let best = "";
  for (const run of runs) {
    if (run.length > best.length && right.includes(run)) best = run;
  }
  const rightRuns = right.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu) || [];
  for (const run of rightRuns) {
    if (run.length > best.length && left.includes(run)) best = run;
  }
  return best;
}

export function isDistinctiveCjkRun(run, minLength) {
  if (!run || run.length < minLength) return false;
  if (/[ァ-ヶー]{3,}/.test(run)) return true;
  if (/\p{Script=Han}{3,}/u.test(run)) return true;
  return false;
}

export function titleOverlapEvidence(leftTitle, rightTitle, overlapConfig) {
  const left = leftTitle ?? "";
  const right = rightTitle ?? "";
  const similarity = titleSimilarity(left, right, {
    nGramSize: 3,
    minLength: overlapConfig.minTitleLength,
  });
  if (similarity.exact) {
    return { matched: true, kind: "title-overlap", detail: "exact-title" };
  }

  const leftTerms = extractTerms(left);
  const rightTerms = extractTerms(right);
  const rightTermSet = new Set(rightTerms);
  const sharedTerms = leftTerms.filter((term) => rightTermSet.has(term));
  const sharedProper = extractProperNouns(left).filter((term) =>
    extractProperNouns(right).includes(term)
  );
  const properSet = new Set(sharedProper);
  const longShared = sharedTerms.filter(
    (term) => term.length >= overlapConfig.minLongSharedTermLength
  );
  const distinctiveLong = longShared.filter(
    (term) =>
      properSet.has(term) ||
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)
  );
  const cjkRun = longestSharedCjkRun(left, right);

  if (
    similarity.comparable &&
    similarity.score != null &&
    similarity.score >= overlapConfig.minDice &&
    sharedProper.length >= overlapConfig.minSharedProperNouns
  ) {
    return {
      matched: true,
      kind: "title-overlap",
      detail: "high-dice",
      titleSimilarity: similarity.score,
      sharedProperNouns: sharedProper,
    };
  }

  if (isDistinctiveCjkRun(cjkRun, overlapConfig.minSharedCjkRun)) {
    return {
      matched: true,
      kind: "title-overlap",
      detail: "shared-cjk-run",
      sharedCjkRun: cjkRun,
    };
  }

  if (
    distinctiveLong.length >= 1 &&
    sharedTerms.length >= overlapConfig.minSharedTermsWithLong
  ) {
    return {
      matched: true,
      kind: "title-overlap",
      detail: "long-shared-term",
      sharedTerms,
      longSharedTerms: distinctiveLong,
    };
  }

  return { matched: false };
}

function itemToClusterId(clusters) {
  const map = new Map();
  for (const cluster of clusters) {
    for (const itemId of cluster.itemIds || []) {
      map.set(itemId, cluster.clusterId);
    }
  }
  return map;
}

export function compareMainEvent(left, right, config) {
  const leftRank = computeMajorRank(left.cluster.scores, config.majorRankWeights);
  const rightRank = computeMajorRank(right.cluster.scores, config.majorRankWeights);
  const leftValue = leftRank == null ? -1 : leftRank;
  const rightValue = rightRank == null ? -1 : rightRank;
  if (rightValue !== leftValue) return rightValue - leftValue;

  const leftIv = Number.isInteger(left.cluster.scores?.informationValue)
    ? left.cluster.scores.informationValue
    : -1;
  const rightIv = Number.isInteger(right.cluster.scores?.informationValue)
    ? right.cluster.scores.informationValue
    : -1;
  if (rightIv !== leftIv) return rightIv - leftIv;

  const published = compareNewerFirst(
    left.cluster.representative?.publishedAt,
    right.cluster.representative?.publishedAt
  );
  if (published !== 0) return published;
  if (left.cluster.clusterId < right.cluster.clusterId) return -1;
  if (left.cluster.clusterId > right.cluster.clusterId) return 1;
  return 0;
}

export function buildRelatedGroups(records, semantic, config) {
  const clusters = records.map((record) => record.cluster);
  const ids = clusters.map((cluster) => cluster.clusterId);
  const { find, union } = createUnionFind(ids);
  const pairEvidence = new Map();

  function addEvidence(clusterA, clusterB, evidence) {
    if (clusterA === clusterB) return;
    union(clusterA, clusterB);
    const key = pairKey(clusterA, clusterB);
    if (!pairEvidence.has(key)) pairEvidence.set(key, []);
    const list = pairEvidence.get(key);
    if (!list.some((entry) => entry.kind === evidence.kind && entry.detail === evidence.detail)) {
      list.push({
        ...evidence,
        clusterA: clusterA < clusterB ? clusterA : clusterB,
        clusterB: clusterA < clusterB ? clusterB : clusterA,
      });
    }
  }

  const itemCluster = itemToClusterId(clusters);
  for (const judgment of semantic.judgments || []) {
    if (judgment.status !== "ok" || judgment.relationship !== "related-event") {
      continue;
    }
    const clusterA = itemCluster.get(judgment.itemA);
    const clusterB = itemCluster.get(judgment.itemB);
    if (!clusterA || !clusterB || clusterA === clusterB) continue;
    addEvidence(clusterA, clusterB, {
      kind: "semantic-related-event",
      detail: "related-event",
      itemA: judgment.itemA,
      itemB: judgment.itemB,
      confidence: judgment.confidence ?? null,
    });
  }

  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const left = records[i];
      const right = records[j];
      const overlap = titleOverlapEvidence(
        left.cluster.representative?.title,
        right.cluster.representative?.title,
        config.titleOverlap
      );
      if (overlap.matched) {
        addEvidence(left.cluster.clusterId, right.cluster.clusterId, overlap);
      }
    }
  }

  const grouped = new Map();
  for (const record of records) {
    const root = find(record.cluster.clusterId);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(record);
  }

  const groups = [];
  for (const members of grouped.values()) {
    const sortedMembers = [...members].sort((left, right) =>
      compareMainEvent(left, right, config)
    );
    const clusterIds = sortedMembers.map((record) => record.cluster.clusterId);
    const relatedGroupId = relatedGroupIdFor(clusterIds);
    const evidence = [];
    for (let i = 0; i < clusterIds.length; i += 1) {
      for (let j = i + 1; j < clusterIds.length; j += 1) {
        const key = pairKey(clusterIds[i], clusterIds[j]);
        for (const entry of pairEvidence.get(key) || []) {
          evidence.push(entry);
        }
      }
    }
    evidence.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
      if (left.clusterA !== right.clusterA) return left.clusterA < right.clusterA ? -1 : 1;
      if (left.clusterB !== right.clusterB) return left.clusterB < right.clusterB ? -1 : 1;
      return 0;
    });

    sortedMembers.forEach((record, index) => {
      record.relatedGroupId = relatedGroupId;
      record.editorialRole = index === 0 ? "main-event" : "related";
    });

    groups.push({
      relatedGroupId,
      members: sortedMembers,
      evidence,
    });
  }

  groups.sort((left, right) => {
    if (right.members.length !== left.members.length) {
      return right.members.length - left.members.length;
    }
    if (left.relatedGroupId < right.relatedGroupId) return -1;
    if (left.relatedGroupId > right.relatedGroupId) return 1;
    return 0;
  });

  return groups;
}
