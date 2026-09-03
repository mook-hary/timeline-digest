import fs from "node:fs/promises";
import path from "node:path";
import { generateDigestItem } from "../ai/digest-generator.js";
import { buildDigestResponsesPayload } from "../ai/digest-prompt.js";
import { ROOT_DIR } from "../config.js";
import { writeJsonAtomic, writeTextAtomic } from "../lib/atomic-write.js";
import { validateRequestLimit } from "../lib/cli-limit.js";
import { AiError, ValidationError } from "../lib/errors.js";
import {
  cacheEntryFromDigest,
  digestCacheKey,
  digestContentHash,
  loadDigestCache,
  saveDigestCache,
} from "./digest-cache.js";
import {
  assertDigestPartition,
  buildDigestDocument,
  buildDigestItem,
  buildDigestReviewDocument,
  fallbackDigestText,
} from "./digest-document.js";
import {
  joinDigestRecords,
  validateEvaluatedDigestInput,
  validateSelectedDigestInput,
} from "./digest-inputs.js";
import { renderDigestMarkdown } from "./digest-markdown.js";
import { validateNormalizedDocument } from "./news-pool.js";

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

function relativePath(filePath, rootDir) {
  if (!filePath) return null;
  return path.relative(rootDir, path.resolve(filePath)).replaceAll("\\", "/");
}

function promptHasForbiddenFields(input) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    return true;
  }
  const forbidden = ["scores", "baseScore", "reason", "rank", "personalRelevance"];
  const json = JSON.stringify(parsed);
  for (const key of forbidden) {
    if (Object.hasOwn(parsed, key)) return true;
    if (parsed.representative && Object.hasOwn(parsed.representative, key)) return true;
  }
  if (/"scores"\s*:/.test(json) || /"baseScore"\s*:/.test(json) || /"reason"\s*:/.test(json)) {
    return true;
  }
  return false;
}

export function digestPayloadForRecord(record, digestConfig) {
  const payload = buildDigestResponsesPayload({
    model: digestConfig.model,
    representative: record.representativeItem,
    members: record.members,
    signals: record.signals,
    topicGroup: record.topicGroup,
    lane: record.lane,
    clipChars: digestConfig.summaryClipChars,
    maxSupportingItems: digestConfig.maxSupportingItems,
  });
  if (promptHasForbiddenFields(payload.input)) {
    throw new ValidationError("digest prompt must not include scores or reasons");
  }
  return {
    payload,
    contentHash: digestContentHash(payload.input),
  };
}

export async function runDigestPipeline(options = {}) {
  const dryRun = options.dryRun === true;
  const applyAi = options.applyAi === true;
  const requestLimit = validateRequestLimit(options.requestLimit);
  const digestConfig = options.digestConfig;
  if (!digestConfig) {
    throw new ValidationError("Digest config is required");
  }

  const rootDir = options.rootDir || ROOT_DIR;
  const selectedPath = options.selectedPath;
  const evaluatedPath = options.evaluatedPath;
  const poolPath = options.poolPath;

  const selected = options.selected
    ? validateSelectedDigestInput(options.selected)
    : validateSelectedDigestInput(await readJsonFile(selectedPath, "Selected document"));
  const evaluated = options.evaluated
    ? validateEvaluatedDigestInput(options.evaluated)
    : validateEvaluatedDigestInput(
        await readJsonFile(evaluatedPath, "Evaluated document")
      );
  const pool = options.pool
    ? validateNormalizedDocument(options.pool, "news-pool")
    : validateNormalizedDocument(await readJsonFile(poolPath, "News pool"), "news-pool");

  const records = joinDigestRecords({ selected, evaluated, pool });
  const generatedAt =
    typeof options.now === "function" ? options.now() : new Date().toISOString();

  const cachePath = options.cachePath;
  const cache = cachePath
    ? await loadDigestCache(cachePath)
    : { schemaVersion: 1, entries: {} };

  let cacheHits = 0;
  let cacheMisses = 0;
  let judgeCalls = 0;
  let cacheDirty = false;

  if (applyAi && typeof options.generator !== "function") {
    throw new AiError("Digest generator is not configured");
  }

  const items = [];
  for (const record of records) {
    const { payload, contentHash } = digestPayloadForRecord(record, digestConfig);
    const key = digestCacheKey({
      clusterId: record.clusterId,
      contentHash,
      model: digestConfig.model,
      generatorVersion: digestConfig.generatorVersion,
    });
    const cached = cache.entries[key];
    const hasCache = Boolean(cached && cached.status === "ok");
    if (hasCache) cacheHits += 1;
    else cacheMisses += 1;

    const fallbackText = fallbackDigestText(record);
    const useCacheText = applyAi && hasCache;

    if (useCacheText) {
      items.push(
        buildDigestItem(
          record,
          {
            status: "ok",
            model: cached.model,
            generatorVersion: cached.generatorVersion,
            cacheHit: true,
          },
          {
            headline: cached.headline,
            summary: cached.summary,
            whyItMatters: cached.whyItMatters,
          }
        )
      );
      continue;
    }

    if (!applyAi || dryRun) {
      items.push(
        buildDigestItem(
          record,
          {
            status: "fallback",
            model: digestConfig.model,
            generatorVersion: digestConfig.generatorVersion,
            cacheHit: false,
          },
          fallbackText
        )
      );
      continue;
    }

    if (requestLimit != null && judgeCalls >= requestLimit) {
      items.push(
        buildDigestItem(
          record,
          {
            status: "fallback",
            model: digestConfig.model,
            generatorVersion: digestConfig.generatorVersion,
            cacheHit: false,
          },
          fallbackText
        )
      );
      continue;
    }

    judgeCalls += 1;
    const judged = await generateDigestItem(payload, options.generator, {
      groundedInput: payload.input,
      headlineMinChars: digestConfig.headlineMinChars,
      headlineMaxChars: digestConfig.headlineMaxChars,
      summaryMaxChars: digestConfig.summaryMaxChars,
      whyItMattersMaxChars: digestConfig.whyItMattersMaxChars,
    });

    if (judged.status === "ok") {
      cache.entries[key] = cacheEntryFromDigest(record.clusterId, judged, {
        contentHash,
        model: digestConfig.model,
        generatorVersion: digestConfig.generatorVersion,
        generatedAt,
      });
      cacheDirty = true;
      items.push(
        buildDigestItem(
          record,
          {
            status: "ok",
            model: digestConfig.model,
            generatorVersion: digestConfig.generatorVersion,
            cacheHit: false,
          },
          {
            headline: judged.headline,
            summary: judged.summary,
            whyItMatters: judged.whyItMatters,
          }
        )
      );
      continue;
    }

    items.push(
      buildDigestItem(
        record,
        {
          status: "failed",
          model: digestConfig.model,
          generatorVersion: digestConfig.generatorVersion,
          cacheHit: false,
          error: judged.error,
          errorDetail: judged.errorDetail,
        },
        fallbackText
      )
    );
  }

  assertDigestPartition(records, items);

  const document = buildDigestDocument({
    generatedAt,
    sourceSelection: {
      path: relativePath(options.sourceSelectionPath || selectedPath, rootDir),
      generatedAt: selected.generatedAt ?? null,
    },
    digestConfig,
    items,
    stats: {
      inputSelected: records.length,
      cacheHits,
      cacheMisses,
      estimatedAiRequests: cacheMisses,
      judgeCalls: applyAi && !dryRun ? judgeCalls : 0,
      requestLimit,
      dryRun,
      applyAi: applyAi && !dryRun,
    },
  });
  const review = buildDigestReviewDocument({ generatedAt, items });
  const markdown = renderDigestMarkdown(document);

  if (!dryRun) {
    if (options.outputPath) {
      await writeJsonAtomic(options.outputPath, document);
    }
    if (options.markdownPath) {
      await writeTextAtomic(options.markdownPath, markdown);
    }
    if (options.reviewPath) {
      await writeJsonAtomic(options.reviewPath, review);
    }
    if (applyAi && cacheDirty && cachePath) {
      await saveDigestCache(cachePath, cache);
    }
  }

  return {
    document,
    review,
    markdown,
    records,
    stats: {
      ...document.stats,
      apiCalls: applyAi && !dryRun ? judgeCalls : 0,
      sourceCount: items.reduce((total, item) => total + item.sources.length, 0),
      major: items.filter((item) => item.lane === "major").length,
      personal: items.filter((item) => item.lane === "personal").length,
    },
    selected,
    evaluated,
    pool,
  };
}

export function digestExitCode(result) {
  if (!result) return 1;
  const stats = result.stats || result.document?.stats || {};
  if (stats.dryRun || !stats.applyAi || stats.judgeCalls === 0) {
    return 0;
  }
  if (stats.failed > 0 && stats.failed === stats.judgeCalls) return 1;
  if (stats.failed > 0) return 2;
  return 0;
}
