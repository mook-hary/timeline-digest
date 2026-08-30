import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  EVALUATION_CONFIG_PATH,
  NEWS_EVALUATED_PATH,
  NEWS_POOL_PATH,
  NEWS_SEMANTIC_PATH,
} from "./config.js";
import { ValidationError } from "./lib/errors.js";
import { loadEvaluationConfig } from "./sources/evaluation-config.js";
import { runEvaluationPipeline } from "./sources/evaluation-run.js";

function formatCountMap(title, counts) {
  const lines = [title];
  for (const key of Object.keys(counts).sort()) {
    lines.push(`${key}: ${counts[key]}`);
  }
  return lines;
}

export function parseEvaluateArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

function formatRepresentative(cluster, index) {
  const representative = cluster.representative;
  return [
    `${index + 1}. items=${cluster.signals.itemCount} diversity=${cluster.signals.sourceDiversity} ${cluster.signals.providers.join(",") || "(none)"}`,
    `   ${representative.source.provider || "unknown"} | ${representative.title || "(untitled)"}`,
  ].join("\n");
}

export async function runEvaluate(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const dryRun = options.dryRun === true;

  try {
    const evaluationConfig =
      options.evaluationConfig ||
      (await loadEvaluationConfig(options.evaluationConfigPath ?? EVALUATION_CONFIG_PATH));

    const result = await runEvaluationPipeline({
      dryRun,
      evaluationConfig,
      semantic: options.semantic,
      semanticPath: options.semanticPath ?? NEWS_SEMANTIC_PATH,
      pool: options.pool,
      poolPath: options.poolPath ?? NEWS_POOL_PATH,
      outputPath: options.outputPath ?? NEWS_EVALUATED_PATH,
      sourceSemanticPath: options.sourceSemanticPath,
      now: options.now,
      rootDir: options.rootDir,
    });

    const preview = result.clusters.slice(0, 10);
    const heading = dryRun ? "News Evaluation dry-run:" : "News Evaluation:";
    stdout.write(
      [
        heading,
        "",
        `items: ${result.stats.itemCount}`,
        `clusters: ${result.stats.clusterCount}`,
        `planned clusters: ${result.clusters.length}`,
        `singletons: ${result.breakdown.singletonCount}`,
        `multi-item: ${result.breakdown.multiItemClusterCount}`,
        `evaluated: ${result.stats.evaluatedCount}`,
        `unevaluated: ${result.stats.unevaluatedCount}`,
        "",
        ...formatCountMap("Source types:", result.breakdown.sourceTypes),
        "",
        ...formatCountMap("Providers:", result.breakdown.providers),
        "",
        "Representatives:",
        ...(preview.length === 0
          ? ["(none)"]
          : preview.map((cluster, index) => formatRepresentative(cluster, index))),
        "",
      ].join("\n")
    );
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
    const flags = parseEvaluateArgs(process.argv.slice(2));
    process.exitCode = await runEvaluate({
      dryRun: flags.dryRun,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
