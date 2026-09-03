import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createOpenAiDigestGenerator } from "./ai/digest-generator.js";
import {
  DIGEST_CACHE_PATH,
  DIGEST_CONFIG_PATH,
  NEWS_DIGEST_MARKDOWN_PATH,
  NEWS_DIGEST_PATH,
  NEWS_DIGEST_REVIEW_PATH,
  NEWS_EVALUATED_PATH,
  NEWS_POOL_PATH,
  NEWS_SELECTED_PATH,
} from "./config.js";
import { parseRequestLimitArg, validateRequestLimit } from "./lib/cli-limit.js";
import { AiError, ValidationError } from "./lib/errors.js";
import { loadRootEnv } from "./load-env.js";
import { loadDigestConfig } from "./sources/digest-config.js";
import { digestExitCode, runDigestPipeline } from "./sources/digest-run.js";

export function parseDigestArgs(argv) {
  const applyAi = argv.includes("--apply-ai");
  const dryRun = argv.includes("--dry-run");
  return {
    applyAi: applyAi && !dryRun,
    dryRun,
    requestLimit: parseRequestLimitArg(argv),
  };
}

function formatCountMap(title, counts) {
  const lines = [title];
  for (const key of Object.keys(counts).sort()) {
    lines.push(`  ${key}: ${counts[key]}`);
  }
  return lines;
}

export async function runDigest(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const dryRun = options.dryRun === true;
  const applyAi = options.applyAi === true;

  try {
    validateRequestLimit(options.requestLimit);
    const digestConfig =
      options.digestConfig ||
      (await loadDigestConfig(options.digestConfigPath ?? DIGEST_CONFIG_PATH));

    let generator = options.generator;
    if (applyAi && !generator) {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new AiError(
          "OPENAI_API_KEY is not set. Run without --apply-ai, or set the key for --apply-ai."
        );
      }
      generator = createOpenAiDigestGenerator({
        apiKey,
        model: digestConfig.model,
        timeoutMs: digestConfig.openai.timeoutMs,
        maxRetries: digestConfig.openai.maxRetries,
        fetchImpl: options.fetchImpl,
      });
    }

    const result = await runDigestPipeline({
      dryRun,
      applyAi,
      requestLimit: options.requestLimit,
      digestConfig,
      generator,
      selected: options.selected,
      evaluated: options.evaluated,
      pool: options.pool,
      selectedPath: options.selectedPath ?? NEWS_SELECTED_PATH,
      evaluatedPath: options.evaluatedPath ?? NEWS_EVALUATED_PATH,
      poolPath: options.poolPath ?? NEWS_POOL_PATH,
      outputPath: options.outputPath ?? NEWS_DIGEST_PATH,
      markdownPath: options.markdownPath ?? NEWS_DIGEST_MARKDOWN_PATH,
      reviewPath: options.reviewPath ?? NEWS_DIGEST_REVIEW_PATH,
      cachePath: options.cachePath ?? DIGEST_CACHE_PATH,
      sourceSelectionPath: options.sourceSelectionPath ?? NEWS_SELECTED_PATH,
      now: options.now,
      rootDir: options.rootDir,
    });

    const stats = result.stats;
    const heading = dryRun ? "News Digest dry-run:" : "News Digest:";
    const lines = [
      heading,
      "",
      `selected input: ${stats.inputSelected}`,
      `digest items: ${result.document.items.length}`,
      `ok: ${stats.ok}`,
      `fallback: ${stats.fallback}`,
      `failed: ${stats.failed}`,
      `ungenerated: ${stats.ungenerated}`,
      `major: ${stats.major}`,
      `personal: ${stats.personal}`,
      `sources: ${stats.sourceCount}`,
      `cache hits: ${stats.cacheHits}`,
      `cache misses: ${stats.cacheMisses}`,
      `estimated AI requests: ${stats.estimatedAiRequests}`,
      `new requests: ${stats.judgeCalls}`,
      `request limit: ${stats.requestLimit ?? "none"}`,
      `API calls: ${stats.apiCalls}`,
      `model: ${digestConfig.model}`,
      "",
      ...formatCountMap("By status:", {
        ok: stats.ok,
        fallback: stats.fallback,
        failed: stats.failed,
        ungenerated: stats.ungenerated,
      }),
      "",
      "Markdown preview:",
      result.markdown.trimEnd(),
      "",
    ];
    stdout.write(`${lines.join("\n")}\n`);
    return digestExitCode(result);
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
    const flags = parseDigestArgs(process.argv.slice(2));
    process.exitCode = await runDigest({
      applyAi: flags.applyAi,
      dryRun: flags.dryRun,
      requestLimit: flags.requestLimit,
    });
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
