import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createOpenAiEvaluator } from "./ai/openai-client.js";
import {
  EVALUATION_CONFIG_PATH,
  EVALUATION_CACHE_PATH,
  NEWS_EVALUATED_PATH,
  NEWS_POOL_PATH,
  NEWS_SEMANTIC_PATH,
} from "./config.js";
import { parseRequestLimitArg, validateRequestLimit } from "./lib/cli-limit.js";
import { AiError, ValidationError } from "./lib/errors.js";
import { loadRootEnv } from "./load-env.js";
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
  const applyAi = argv.includes("--apply-ai");
  const dryRun = argv.includes("--dry-run");
  return {
    applyAi: applyAi && !dryRun,
    dryRun,
    requestLimit: parseRequestLimitArg(argv),
  };
}

function formatTarget(cluster, index) {
  const representative = cluster.representative;
  return [
    `${index + 1}. items=${cluster.signals.itemCount} diversity=${cluster.signals.sourceDiversity} ${cluster.signals.providers.join(",") || "(none)"}`,
    `   ${representative.source.provider || "unknown"} | ${representative.title || "(untitled)"}`,
  ].join("\n");
}

export function evaluationExitCode(result) {
  if (!result) return 1;
  if (result.stats.dryRun || result.stats.judgeCalls === 0) {
    if (result.stats.failed > 0 && result.stats.judgedCount === result.stats.failed) {
      return 1;
    }
    if (result.stats.failed > 0) return 2;
    return 0;
  }
  if (result.stats.failed > 0 && result.stats.judgedCount === result.stats.failed) {
    return 1;
  }
  if (result.stats.failed > 0) return 2;
  return 0;
}

export async function runEvaluate(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const dryRun = options.dryRun === true;
  const applyAi = options.applyAi === true;

  try {
    validateRequestLimit(options.requestLimit);
    const evaluationConfig =
      options.evaluationConfig ||
      (await loadEvaluationConfig(options.evaluationConfigPath ?? EVALUATION_CONFIG_PATH));

    let evaluator = options.evaluator;
    if (applyAi && !evaluator) {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new AiError(
          "OPENAI_API_KEY is not set. Run without --apply-ai, or set the key for --apply-ai."
        );
      }
      evaluator = createOpenAiEvaluator({
        apiKey,
        model: evaluationConfig.model,
        timeoutMs: evaluationConfig.openai.timeoutMs,
        maxRetries: evaluationConfig.openai.maxRetries,
        fetchImpl: options.fetchImpl,
      });
    }

    const result = await runEvaluationPipeline({
      dryRun,
      applyAi,
      requestLimit: options.requestLimit,
      evaluationConfig,
      evaluator,
      semantic: options.semantic,
      semanticPath: options.semanticPath ?? NEWS_SEMANTIC_PATH,
      pool: options.pool,
      poolPath: options.poolPath ?? NEWS_POOL_PATH,
      outputPath: options.outputPath ?? NEWS_EVALUATED_PATH,
      cachePath: options.cachePath ?? EVALUATION_CACHE_PATH,
      sourceSemanticPath: options.sourceSemanticPath,
      now: options.now,
      rootDir: options.rootDir,
    });

    const targets = (result.evaluationOrder || result.clusters).slice(0, 10);
    const heading = dryRun
      ? "News Evaluation dry-run:"
      : applyAi
        ? "News Evaluation:"
        : "News Evaluation:";
    const lines = [
      heading,
      "",
      `items: ${result.stats.itemCount}`,
      `clusters: ${result.stats.clusterCount}`,
      `planned clusters: ${result.clusters.length}`,
      `singletons: ${result.breakdown.singletonCount}`,
      `multi-item: ${result.breakdown.multiItemClusterCount}`,
      `evaluated: ${result.stats.evaluatedCount}`,
      `unevaluated: ${result.stats.unevaluatedCount}`,
      `failed: ${result.stats.failed}`,
      `unjudged: ${result.stats.unjudged}`,
      `cache hits: ${result.stats.cacheHits}`,
      `estimated AI requests: ${result.stats.estimatedAiRequests}`,
      `new requests: ${result.stats.judgeCalls}`,
      `request limit: ${result.stats.requestLimit ?? "none"}`,
      `model: ${evaluationConfig.model}`,
      "",
      ...formatCountMap("Source types:", result.breakdown.sourceTypes),
      "",
      ...formatCountMap("Providers:", result.breakdown.providers),
      "",
      dryRun || !applyAi ? "Evaluation targets:" : "Representatives:",
      ...(targets.length === 0
        ? ["(none)"]
        : targets.map((cluster, index) => formatTarget(cluster, index))),
      "",
    ];

    stdout.write(`${lines.join("\n")}\n`);
    return evaluationExitCode(result);
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
    const flags = parseEvaluateArgs(process.argv.slice(2));
    process.exitCode = await runEvaluate({
      applyAi: flags.applyAi,
      dryRun: flags.dryRun,
      requestLimit: flags.requestLimit,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
