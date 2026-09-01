import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createOpenAiJudge } from "./ai/openai-client.js";
import {
  CLUSTER_CONFIG_PATH,
  NEWS_POOL_PATH,
  NEWS_SEMANTIC_CANDIDATES_PATH,
  NEWS_SEMANTIC_PATH,
  SEMANTIC_CACHE_PATH,
  SEMANTIC_CONFIG_PATH,
} from "./config.js";
import { parseRequestLimitArg, validateRequestLimit } from "./lib/cli-limit.js";
import { AiError } from "./lib/errors.js";
import { loadRootEnv } from "./load-env.js";
import { loadClusterConfig } from "./sources/cluster-config.js";
import { loadSemanticConfig } from "./sources/semantic-config.js";
import { runSemanticPipeline } from "./sources/semantic-run.js";

export { parseRequestLimitArg, validateRequestLimit };

export function parseSemanticArgs(argv) {
  const applyAi = argv.includes("--apply-ai");
  const dryRunFlag = argv.includes("--dry-run");
  return {
    applyAi: applyAi && !dryRunFlag,
    dryRun: dryRunFlag || !applyAi,
    requestLimit: parseRequestLimitArg(argv),
  };
}

function formatHours(value) {
  if (value == null) return "n/a";
  if (value < 10) return `${value.toFixed(1)}h`;
  return `${Math.round(value)}h`;
}

function formatCandidate(candidate, index) {
  return [
    `${index + 1}. score=${candidate.candidateScore} dice=${candidate.titleSimilarity ?? "n/a"} time=${formatHours(candidate.hoursApart)}`,
    `   ${candidate.providerA} | ${candidate.titleA}`,
    `   ${candidate.providerB} | ${candidate.titleB}`,
  ].join("\n");
}

export function semanticExitCode(result) {
  if (!result) return 1;
  if (result.stats.dryRun) return 0;
  if (result.stats.failed > 0 && result.stats.judgedCount === result.stats.failed) {
    return 1;
  }
  if (result.stats.failed > 0) return 2;
  return 0;
}

export async function runSemantic(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const applyAi = options.applyAi === true;

  try {
    validateRequestLimit(options.requestLimit);
    const semanticConfig =
      options.semanticConfig ||
      (await loadSemanticConfig(options.semanticConfigPath ?? SEMANTIC_CONFIG_PATH));
    const clusterConfig =
      options.clusterConfig ||
      (await loadClusterConfig(options.clusterConfigPath ?? CLUSTER_CONFIG_PATH));

    let judge = options.judge;
    if (applyAi && !judge) {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new AiError(
          "OPENAI_API_KEY is not set. Run with --dry-run, or set the key for --apply-ai."
        );
      }
      judge = createOpenAiJudge({
        apiKey,
        model: semanticConfig.model,
        timeoutMs: semanticConfig.openai.timeoutMs,
        maxRetries: semanticConfig.openai.maxRetries,
        client: options.openaiClient,
      });
    }

    const result = await runSemanticPipeline({
      applyAi,
      requestLimit: options.requestLimit,
      pool: options.pool,
      poolPath: options.poolPath ?? NEWS_POOL_PATH,
      semanticConfig,
      clusterConfig,
      judge,
      cachePath: options.cachePath ?? SEMANTIC_CACHE_PATH,
      outputPath: options.outputPath ?? NEWS_SEMANTIC_PATH,
      candidatesPath: options.candidatesPath ?? NEWS_SEMANTIC_CANDIDATES_PATH,
      sourcePoolPath: options.sourcePoolPath,
      now: options.now,
      rootDir: options.rootDir,
    });

    const top = result.candidates.slice(0, 20);
    const lines = applyAi
      ? [
          "News Semantic:",
          "",
          `items: ${result.stats.itemCount}`,
          `candidates: ${result.stats.candidateCount}`,
          `judged: ${result.stats.judgedCount}`,
          `unjudged: ${result.stats.unjudged}`,
          `new requests: ${result.stats.judgeCalls}`,
          `request limit: ${result.stats.requestLimit ?? "none"}`,
          `same-event: ${result.stats.sameEvent}`,
          `related-event: ${result.stats.relatedEvent}`,
          `different-event: ${result.stats.differentEvent}`,
          `failed: ${result.stats.failed}`,
          `cache hits: ${result.stats.cacheHits}`,
          `cache misses: ${result.stats.cacheMisses}`,
          `conflicts: ${result.stats.conflictCount}`,
          "",
        ]
      : [
          "News Semantic dry-run:",
          "",
          `items: ${result.stats.itemCount}`,
          `candidates: ${result.stats.candidateCount}`,
          `cache hits: ${result.stats.cacheHits}`,
          `estimated AI requests: ${result.stats.estimatedAiRequests}`,
          "",
          "Top candidates:",
          ...(top.length === 0
            ? ["(none)"]
            : top.map((candidate, index) => formatCandidate(candidate, index))),
          "",
        ];

    stdout.write(`${lines.join("\n")}\n`);
    return semanticExitCode(result);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  loadRootEnv();
  try {
    const flags = parseSemanticArgs(process.argv.slice(2));
    process.exitCode = await runSemantic({
      applyAi: flags.applyAi,
      requestLimit: flags.requestLimit,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
