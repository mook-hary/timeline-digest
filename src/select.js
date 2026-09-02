import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  NEWS_EVALUATED_PATH,
  NEWS_SELECTED_PATH,
  NEWS_SELECTED_REVIEW_PATH,
  NEWS_SEMANTIC_PATH,
  SELECT_CONFIG_PATH,
} from "./config.js";
import { ValidationError } from "./lib/errors.js";
import { loadRootEnv } from "./load-env.js";
import { loadSelectConfig } from "./sources/select-config.js";
import { runSelectPipeline } from "./sources/select-run.js";

export function parseSelectArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

function formatCountMap(title, counts) {
  const lines = [title];
  for (const key of Object.keys(counts).sort()) {
    lines.push(`  ${key}: ${counts[key]}`);
  }
  return lines;
}

function formatScores(scores) {
  if (!scores) return "n/a";
  return [
    scores.importance,
    scores.informationValue,
    scores.impact,
    scores.novelty,
    scores.personalRelevance,
  ].join("/");
}

function formatSelected(entry) {
  return [
    `${entry.rank}. [${entry.lane}] ${entry.topicGroup} ${entry.selectionReason} base=${entry.baseScore}`,
    `   ${entry.representative?.title || "(untitled)"}`,
    `   scores=${formatScores(entry.scores)} role=${entry.editorialRole} group=${entry.relatedGroupId}`,
  ].join("\n");
}

function formatReviewGroup(group, index) {
  const evidence = group.evidence
    .map((entry) => entry.kind)
    .filter((kind, inner, list) => list.indexOf(kind) === inner);
  const members = group.members
    .map(
      (member) =>
        `   - ${member.editorialRole}${member.selected ? " SELECTED" : ""} | ${member.title}`
    )
    .join("\n");
  return [
    `${index + 1}. ${group.relatedGroupId} members=${group.memberClusterIds.length} evidence=${evidence.join(",") || "none"}`,
    `   main: ${group.selectedMainEvent?.title || "(none)"}`,
    members,
  ].join("\n");
}

export async function runSelect(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const dryRun = options.dryRun === true;

  try {
    const selectConfig =
      options.selectConfig ||
      (await loadSelectConfig(options.selectConfigPath ?? SELECT_CONFIG_PATH));

    const result = await runSelectPipeline({
      dryRun,
      selectConfig,
      evaluated: options.evaluated,
      semantic: options.semantic,
      evaluatedPath: options.evaluatedPath ?? NEWS_EVALUATED_PATH,
      semanticPath: options.semanticPath ?? NEWS_SEMANTIC_PATH,
      outputPath: options.outputPath ?? NEWS_SELECTED_PATH,
      reviewPath: options.reviewPath ?? NEWS_SELECTED_REVIEW_PATH,
      sourceEvaluationPath: options.sourceEvaluationPath,
      sourceSemanticPath: options.sourceSemanticPath,
      now: options.now,
      rootDir: options.rootDir,
    });

    const stats = result.stats;
    const heading = dryRun ? "News Select dry-run:" : "News Select:";
    const lines = [
      heading,
      "",
      `items/clusters input: ${stats.inputClusters}`,
      `eligible: ${stats.eligible}`,
      `selected: ${stats.selected}`,
      `rejected: ${stats.rejected}`,
      `related groups: ${stats.relatedGroups}`,
      `multi-cluster related groups: ${stats.multiClusterRelatedGroups}`,
      `redundant rejected: ${stats.redundantRejected}`,
      `API calls: 0`,
      "",
      ...formatCountMap("By lane:", stats.byLane),
      "",
      ...formatCountMap("By topicGroup:", stats.byTopicGroup),
      "",
      ...formatCountMap("Rejection reasons:", stats.rejectionReasons),
      "",
      "Selected:",
      ...(result.document.selected.length === 0
        ? ["(none)"]
        : result.document.selected.map((entry) => formatSelected(entry))),
      "",
      "Multi-cluster related groups:",
      ...(result.review.groups.length === 0
        ? ["(none)"]
        : result.review.groups.map((group, index) => formatReviewGroup(group, index))),
      "",
    ];
    stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    stderr.write(`${message}\n`);
    return error instanceof ValidationError || error?.name === "ValidationError" ? 1 : 1;
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  try {
    loadRootEnv();
    const flags = parseSelectArgs(process.argv.slice(2));
    process.exitCode = await runSelect({
      dryRun: flags.dryRun,
    });
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
