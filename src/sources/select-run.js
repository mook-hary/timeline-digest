import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "../config.js";
import { writeJsonAtomic } from "../lib/atomic-write.js";
import { ValidationError } from "../lib/errors.js";
import { eligibilityOf } from "./select-eligibility.js";
import { tagLanes } from "./select-lanes.js";
import { packSelection } from "./select-pack.js";
import { buildRelatedGroups } from "./select-related-groups.js";
import { assignTopicGroup } from "./select-topics.js";
import {
  SELECT_SCHEMA_VERSION,
  assertMembershipUnchanged,
  assertSelectPartition,
  buildRejectedEntry,
  buildReviewDocument,
  buildSelectedEntry,
  validateEvaluatedSelectInput,
  validateSemanticSelectInput,
} from "./select-document.js";

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

function countBy(list, keyFn) {
  const counts = {};
  for (const entry of list) {
    const key = keyFn(entry) || "(none)";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function relativePath(filePath, rootDir) {
  if (!filePath) return null;
  return path.relative(rootDir, path.resolve(filePath)).replaceAll("\\", "/");
}

export function createSelectRecords(clusters, config) {
  return clusters.map((cluster) => {
    const eligibility = eligibilityOf(cluster, config.qualityFloor);
    return {
      cluster,
      originalItemIds: cluster.itemIds.slice(),
      originalRepresentativeItemId: cluster.representative?.itemId ?? null,
      originalScores: cluster.scores ? { ...cluster.scores } : null,
      originalBaseScore: cluster.baseScore,
      topicGroup: assignTopicGroup(cluster, config),
      eligible: eligibility.eligible,
      ineligibilityReason: eligibility.reason,
      relatedGroupId: null,
      editorialRole: null,
      lanes: [],
      lane: null,
      decision: null,
    };
  });
}

export async function runSelectPipeline(options = {}) {
  const dryRun = options.dryRun === true;
  const generatedAt = (options.now || (() => new Date().toISOString()))();
  const rootDir = options.rootDir || ROOT_DIR;
  const config = options.selectConfig;
  if (config == null) {
    throw new ValidationError("Select config is required");
  }

  const evaluatedPath = options.evaluatedPath;
  const semanticPath = options.semanticPath;
  const evaluated = validateEvaluatedSelectInput(
    options.evaluated || (await readJsonFile(evaluatedPath, "Evaluated document"))
  );
  const semantic = validateSemanticSelectInput(
    options.semantic || (await readJsonFile(semanticPath, "Semantic document"))
  );

  const records = createSelectRecords(evaluated.clusters, config);
  for (const record of records) {
    tagLanes(record, config);
  }
  const groups = buildRelatedGroups(records, semantic, config);
  packSelection(records, config);
  assertMembershipUnchanged(records);

  const selectedRecords = records
    .filter((record) => record.decision === "selected")
    .sort((left, right) => left.rank - right.rank);
  const rejectedRecords = records.filter((record) => record.decision === "rejected");
  assertSelectPartition(records, selectedRecords, rejectedRecords);

  if (selectedRecords.length > config.digestMax) {
    throw new ValidationError(
      `selected ${selectedRecords.length} exceeds digestMax ${config.digestMax}`
    );
  }

  const selected = selectedRecords.map((record) => buildSelectedEntry(record));
  const rejected = rejectedRecords
    .map((record) => buildRejectedEntry(record))
    .sort((left, right) => {
      if (left.clusterId < right.clusterId) return -1;
      if (left.clusterId > right.clusterId) return 1;
      return 0;
    });
  const selectedIds = new Set(selected.map((entry) => entry.clusterId));
  const review = buildReviewDocument({ generatedAt, groups, selectedIds });

  const stats = {
    inputClusters: evaluated.clusters.length,
    eligible: records.filter((record) => record.eligible).length,
    selected: selected.length,
    rejected: rejected.length,
    byLane: countBy(selected, (entry) => entry.lane),
    byTopicGroup: countBy(selected, (entry) => entry.topicGroup),
    rejectionReasons: countBy(rejected, (entry) => entry.rejectionReason),
    relatedGroups: groups.length,
    multiClusterRelatedGroups: review.multiClusterRelatedGroupCount,
    redundantRejected: rejected.filter((entry) => entry.rejectionReason === "redundant")
      .length,
    dryRun,
  };

  const document = {
    schemaVersion: SELECT_SCHEMA_VERSION,
    generatedAt,
    sourceEvaluation: {
      path:
        options.sourceEvaluationPath ||
        relativePath(evaluatedPath, rootDir) ||
        "data/processed/news-evaluated.json",
      generatedAt: evaluated.generatedAt || null,
    },
    sourceSemantic: {
      path:
        options.sourceSemanticPath ||
        relativePath(semanticPath, rootDir) ||
        "data/processed/news-semantic.json",
      generatedAt: semantic.generatedAt || null,
    },
    selectionPolicy: {
      id: config.policyId,
      digestTarget: config.digestTarget,
      digestMax: config.digestMax,
      majorCap: config.majorCap,
      personalCap: config.personalCap,
    },
    stats,
    selected,
    rejected,
  };

  if (!dryRun && options.outputPath) {
    await writeJsonAtomic(options.outputPath, document);
  }
  if (!dryRun && options.reviewPath) {
    await writeJsonAtomic(options.reviewPath, review);
  }

  return {
    document,
    review,
    stats,
    records,
    groups,
    dryRun,
  };
}
