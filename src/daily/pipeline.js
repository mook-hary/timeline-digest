import fs from "node:fs/promises";
import * as configPaths from "../config.js";
import { ingestXFeed, validateXFeed } from "../sources/x-feed.js";
import { ingestWebFeeds } from "../sources/web-feed.js";
import { unifyNewsPool } from "../sources/news-pool.js";
import { clusterNewsPool } from "../sources/news-clusters.js";
import { runSemanticPipeline } from "../sources/semantic-run.js";
import { runEvaluationPipeline } from "../sources/evaluation-run.js";
import { runSelectPipeline } from "../sources/select-run.js";
import { runDigestPipeline, digestExitCode } from "../sources/digest-run.js";
import { generateReferencesCandidates } from "../sources/references-candidates.js";
import { runReferencesSelectionPipeline } from "../sources/references-selection.js";
import { loadClusterConfig } from "../sources/cluster-config.js";
import { loadSemanticConfig } from "../sources/semantic-config.js";
import { loadEvaluationConfig } from "../sources/evaluation-config.js";
import { loadSelectConfig } from "../sources/select-config.js";
import { loadDigestConfig } from "../sources/digest-config.js";
import { loadReferencesSelectionConfig } from "../sources/references-selection-config.js";
import { loadSemanticCache } from "../sources/semantic-cache.js";
import { loadEvaluationCache } from "../sources/evaluation-cache.js";
import { loadDigestCache } from "../sources/digest-cache.js";
import { createOpenAiJudge, createOpenAiEvaluator } from "../ai/openai-client.js";
import { createOpenAiDigestGenerator } from "../ai/digest-generator.js";
import { writeJsonAtomic } from "../lib/atomic-write.js";
import { boundedFetch, DailyError } from "./fetch.js";
import { assessXFreshness, validateFreshnessPolicy } from "./freshness.js";
import { runDaily, loadDailyConfig } from "./run.js";
import { workPath } from "./state.js";
import { FILES, STAGE_ORDER, AI_STAGES, OUTPUT_KEYS, DAILY_DIAGNOSTICS } from "./contract.js";
import { createEditionCandidate } from "./edition.js";

export function productionStages(moduleUrl = import.meta.url) {
  return STAGE_ORDER.map(id => ({ id, moduleUrl, ai: AI_STAGES.has(id),
    outputs: Object.fromEntries(OUTPUT_KEYS[id].map(key => [key, FILES[key]])) }));
}

export async function runProductionDaily(options = {}) {
  const config = options.config ?? loadDailyConfig();
  validateFreshnessPolicy(config);
  return runDaily({ ...options, config, mode: "candidate", stages: productionStages(options.moduleUrl) });
}

const safeAi = fn => async (...args) => {
  try { return await fn(...args); }
  catch { throw new Error("ai_request_failed"); }
};

async function seedCache(kind, target, dependencies) {
  const settings = {
    semantic: [loadSemanticCache, configPaths.SEMANTIC_CACHE_PATH],
    evaluation: [loadEvaluationCache, configPaths.EVALUATION_CACHE_PATH],
    digest: [loadDigestCache, configPaths.DIGEST_CACHE_PATH],
  };
  const [loader, source] = settings[kind];
  // Tests supply temporary sources; never open canonical caches in fixtures.
  const cache = await loader(dependencies.cacheSources?.[kind] ?? source);
  const fields = {
    semantic: ["itemA", "itemB", "contentHashA", "contentHashB", "model", "judgeVersion", "relationship", "confidence", "reason", "judgedAt", "status"],
    evaluation: ["clusterId", "contentHash", "model", "evaluatorVersion", "scores", "reason", "judgedAt", "status"],
    digest: ["clusterId", "contentHash", "model", "generatorVersion", "headline", "summary", "whyItMatters", "generatedAt", "status"],
  };
  const entries = Object.fromEntries(Object.entries(cache.entries).filter(([, entry]) => entry?.status === "ok")
    .map(([key, entry]) => [key, Object.fromEntries(fields[kind].filter(field => Object.hasOwn(entry, field)).map(field => [field, entry[field]]))]));
  await writeJsonAtomic(target, { schemaVersion: 1, entries });
}

function clientOptions(config) {
  if (!process.env.OPENAI_API_KEY) throw new DailyError("ai_credentials_missing");
  return { apiKey: process.env.OPENAI_API_KEY, model: config.model, timeoutMs: config.openai.timeoutMs, maxRetries: config.openai.maxRetries };
}

// Dependency injection is for local tests, not CLI flags. Real adapters share
// the exact pipeline functions, policies and edition validator exercised here.
export async function executePipelineStage(ctx, dependencies = {}) {
  const p = key => workPath(ctx.workDir, FILES[key]);
  const read = async key => JSON.parse(await fs.readFile(p(key), "utf8"));
  const now = dependencies.now ?? (() => ctx.clock.fixed ? ctx.clock.at : new Date().toISOString());
  const common = { now, rootDir: ctx.workDir };
  const diagnostics = [];
  const operations = { ingestXFeed, ingestWebFeeds, unifyNewsPool, clusterNewsPool, runSemanticPipeline,
    runEvaluationPipeline, runSelectPipeline, runDigestPipeline, generateReferencesCandidates, runReferencesSelectionPipeline,
    ...dependencies.operations };
  try {
    validateFreshnessPolicy(ctx.config);
    switch (ctx.stageId) {
      case "ingest:x": {
        const observations = new Map();
        const fetchImpl = boundedFetch({ fetchImpl: dependencies.fetchImpl, timeoutMs: ctx.config.fetch.timeoutMs, now, observations });
        try {
          await operations.ingestXFeed({ url: configPaths.X_FEED_URL, rawPath: p("xRaw"), normalizedPath: p("x"), fetchImpl, now });
        } catch {
          throw new DailyError(observations.get(configPaths.X_FEED_URL)?.diagnostic ?? "x_schema_invalid");
        }
        const feed = validateXFeed(await read("xRaw"));
        const retrieval = { ...observations.get(configPaths.X_FEED_URL), runId: ctx.runId };
        const freshness = assessXFreshness(feed, { now: now(), policy: ctx.config.freshness.x, retrieval, runId: ctx.runId, startedAt: ctx.startedAt });
        await writeJsonAtomic(p("xReceipt"), { schemaVersion: 1, ...retrieval, ...freshness, itemCount: feed.items.length });
        break;
      }
      case "ingest:web": {
        const observations = new Map();
        const result = await operations.ingestWebFeeds({ configPath: configPaths.WEB_SOURCES_PATH, sourcesConfig: dependencies.webSources,
          rawDir: workPath(ctx.workDir, "raw/web"), normalizedPath: p("web"), now,
          fetchImpl: boundedFetch({ fetchImpl: dependencies.fetchImpl, timeoutMs: ctx.config.fetch.timeoutMs, now, observations }) });
        const sources = result.sourceResults.map(source => {
          const retrieval = observations.get(source.source.url);
          const succeeded = source.status === "ok" && retrieval?.status === "succeeded";
          const old = succeeded && source.sourceFeed.sourceGeneratedAt != null &&
            Date.parse(now()) - Date.parse(source.sourceFeed.sourceGeneratedAt) > ctx.config.freshness.web.oldMetadataDiagnosticDays * 86400000;
          return { provider: source.source.id, status: succeeded ? "succeeded" : "failed", fetchedAt: succeeded ? retrieval.fetchedAt : null,
            sourceGeneratedAt: source.sourceFeed.sourceGeneratedAt, itemCount: source.items.length,
            diagnostic: succeeded ? old ? "web_metadata_old" : null : retrieval?.diagnostic ?? "fetch_malformed" };
        });
        await writeJsonAtomic(p("webReceipt"), { schemaVersion: 1, runId: ctx.runId, sources });
        if (!sources.some(s => s.status === "succeeded")) throw new DailyError("web_all_failed");
        if (sources.some(s => s.status === "failed")) diagnostics.push("web_source_failed");
        if (sources.some(s => s.diagnostic === "web_metadata_old")) diagnostics.push("web_metadata_old");
        // Keep arbitrary parser/HTTP messages out of the run-local diagnostics.
        for (const feed of result.document.sourceFeeds) if (feed.status === "error") feed.error = sources.find(s => s.provider === feed.provider).diagnostic;
        await writeJsonAtomic(p("web"), result.document);
        break;
      }
      case "unify":
        await operations.unifyNewsPool({ ...common, inputsConfig: { schemaVersion: 1, inputs: [
          { id: "x", path: FILES.x, required: true }, { id: "web", path: FILES.web, required: true },
        ] }, outputPath: p("pool") });
        break;
      case "cluster":
        await operations.clusterNewsPool({ ...common, poolPath: p("pool"), clusterConfigPath: configPaths.CLUSTER_CONFIG_PATH,
          outputPath: p("cluster"), reviewPath: p("clusterReview") });
        break;
      case "semantic": {
        const semanticConfig = await loadSemanticConfig(configPaths.SEMANTIC_CONFIG_PATH);
        const clusterConfig = await loadClusterConfig(configPaths.CLUSTER_CONFIG_PATH);
        const judge = safeAi(dependencies.judge ?? createOpenAiJudge(clientOptions(semanticConfig)));
        await seedCache("semantic", p("semanticCache"), dependencies);
        const result = await operations.runSemanticPipeline({ ...common, applyAi: true, semanticConfig, clusterConfig, judge,
          poolPath: p("pool"), outputPath: p("semantic"), cachePath: p("semanticCache") });
        if (result.stats.dryRun || result.stats.failed || result.stats.unjudged || result.judgments.length !== result.candidates.length || result.judgments.some(j => j.status !== "ok")) throw new DailyError("semantic_incomplete");
        // Existing semantic logic recomputes deterministic relationships; adjust
        // its descriptive path to the equivalent run-local cluster artifact.
        result.document.deterministicClusters.path = FILES.cluster;
        await writeJsonAtomic(p("semantic"), result.document);
        break;
      }
      case "evaluate": {
        const evaluationConfig = await loadEvaluationConfig(configPaths.EVALUATION_CONFIG_PATH);
        const evaluator = safeAi(dependencies.evaluator ?? createOpenAiEvaluator(clientOptions(evaluationConfig)));
        await seedCache("evaluation", p("evaluationCache"), dependencies);
        const result = await operations.runEvaluationPipeline({ ...common, applyAi: true, evaluationConfig, evaluator,
          semanticPath: p("semantic"), poolPath: p("pool"), outputPath: p("evaluated"), cachePath: p("evaluationCache") });
        if (result.stats.dryRun || result.stats.failed || result.stats.unevaluatedCount || result.stats.unjudged ||
          result.clusters.some(c => c.status !== "evaluated") || result.clusters.length !== (await read("semantic")).clusters.length) throw new DailyError("evaluation_incomplete");
        break;
      }
      case "select":
        await operations.runSelectPipeline({ ...common, selectConfig: await loadSelectConfig(configPaths.SELECT_CONFIG_PATH),
          evaluatedPath: p("evaluated"), semanticPath: p("semantic"), outputPath: p("selected"), reviewPath: p("selectReview") });
        break;
      case "digest": {
        const digestConfig = await loadDigestConfig(configPaths.DIGEST_CONFIG_PATH);
        const generator = safeAi(dependencies.generator ?? createOpenAiDigestGenerator(clientOptions(digestConfig)));
        await seedCache("digest", p("digestCache"), dependencies);
        const result = await operations.runDigestPipeline({ ...common, applyAi: true, digestConfig, generator,
          selectedPath: p("selected"), evaluatedPath: p("evaluated"), poolPath: p("pool"),
          outputPath: p("digest"), markdownPath: p("markdown"), reviewPath: p("digestReview"), cachePath: p("digestCache") });
        if (digestExitCode(result) === 1 || !result.stats.applyAi || result.stats.dryRun) throw new DailyError("digest_failed");
        if (result.document.items.some(item => item.status !== "ok")) diagnostics.push("digest_fallback");
        break;
      }
      case "references": {
        const result = await operations.generateReferencesCandidates({ ...common, poolPath: p("pool"), outputPath: p("candidates") });
        if (!result.document.items.length) diagnostics.push("references_empty");
        break;
      }
      case "references:select":
        await operations.runReferencesSelectionPipeline({ ...common, candidatesPath: p("candidates"), outputPath: p("references"),
          selectionConfig: await loadReferencesSelectionConfig(configPaths.REFERENCES_SELECTION_CONFIG_PATH) });
        break;
      case "validate-edition":
        await createEditionCandidate(ctx, { now: now() });
        break;
      default: throw new DailyError("pipeline_failed");
    }
    return { status: diagnostics.length ? "degraded" : "succeeded", diagnostics };
  } catch (error) {
    return { status: "failed", diagnostics: [error instanceof DailyError && DAILY_DIAGNOSTICS.has(error.code) ? error.code : ctx.stageId === "validate-edition" ? "edition_invalid" : "pipeline_failed"] };
  }
}

export default executePipelineStage;
