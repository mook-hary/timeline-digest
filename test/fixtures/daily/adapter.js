// This fixture calls the real Daily adapters/core stages, replacing only external
// fetch/AI dependencies and allowing explicit failure injection. No real client.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { executePipelineStage } from "../../../src/daily/pipeline.js";
import { runSemanticPipeline } from "../../../src/sources/semantic-run.js";
import { runEvaluationPipeline } from "../../../src/sources/evaluation-run.js";
import { runDigestPipeline } from "../../../src/sources/digest-run.js";
import { generateReferencesCandidates } from "../../../src/sources/references-candidates.js";
import { runReferencesSelectionPipeline } from "../../../src/sources/references-selection.js";
import { X_FEED_URL } from "../../../src/config.js";
import { AI_STAGES } from "../../../src/daily/contract.js";

export default async function(ctx) {
  // Any accidental fallback to a real network client fails locally.
  globalThis.fetch = async () => { throw new Error("Live network forbidden in fixture"); };
  const root = path.resolve(ctx.workDir, "../../..");
  const scenario = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));
  if (scenario.checkEnvironment) {
    assert.equal(process.env.OPENAI_API_KEY, AI_STAGES.has(ctx.stageId) ? "test-only-credential" : undefined);
    assert.equal(process.env.UNRELATED_SECRET, undefined);
  }
  const logPath = path.join(ctx.workDir, "calls.json");
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath)) : [];
  log.push({ stage: ctx.stageId });
  fs.writeFileSync(logPath, JSON.stringify(log));
  let digestCalls = 0;
  const fetchImpl = async (url, { signal }) => {
    const feed = url === X_FEED_URL ? scenario.x : scenario.web.find(s => s.url === url);
    if (!feed || feed.failure === "source") throw new Error("offline");
    if (feed.failure === "timeout") return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
    if (feed.failure === "http") return { ok: false, status: 503, text: async () => "" };
    return { ok: true, status: 200, text: async () => url === X_FEED_URL ? (scenario.xMalformed ? "{" : JSON.stringify(feed)) : feed.xml };
  };
  const trace = (name, fn) => async options => {
    assert.equal(options.applyAi, true);
    assert.equal(options.requestLimit, undefined);
    for (const key of ["poolPath", "semanticPath", "selectedPath", "evaluatedPath", "outputPath", "cachePath", "markdownPath", "reviewPath"]) {
      if (options[key]) assert.ok(options[key].startsWith(`${ctx.workDir}${path.sep}`), key);
    }
    fs.writeFileSync(path.join(ctx.workDir, `${name}-options.json`), JSON.stringify({ applyAi: options.applyAi, requestLimit: options.requestLimit ?? null }));
    const result = await fn(options);
    if (scenario.incomplete === name) {
      result.stats.unjudged = 1;
    }
    return result;
  };
  const dependencies = {
    fetchImpl,
    webSources: { schemaVersion: 1, sources: scenario.web.map(({ id, url }) => ({ id, name: id, url, type: "rss", enabled: true })) },
    cacheSources: Object.fromEntries(["semantic", "evaluation", "digest"].map(kind => [kind, path.join(root, `${kind}-seed.json`)])),
    judge: async () => {
      if (scenario.aiFailure === "semantic" || scenario.noAiCalls) throw new Error("test-only-credential");
      return { relationship: "different-event", confidence: 0.9, reason: "Fixture distinction" };
    },
    evaluator: async () => {
      if (scenario.aiFailure === "evaluate" || scenario.noAiCalls) throw new Error("test-only-credential");
      return { scores: { importance: 5, informationValue: 5, impact: 5, novelty: 4, personalRelevance: 4 }, reason: "Fixture evaluation" };
    },
    generator: async () => {
      digestCalls++;
      if (scenario.aiFailure === "digest" || scenario.noAiCalls || (scenario.digestFallback && digestCalls === 1)) throw new Error("test-only-credential");
      return { headline: "宇宙開発に関する新たな発表", summary: "研究機関が新たな計画の詳細を発表した。", whyItMatters: "計画の変更が今後の研究日程に影響する。" };
    },
    operations: {
      runSemanticPipeline: trace("semantic", runSemanticPipeline),
      runEvaluationPipeline: trace("evaluate", runEvaluationPipeline),
      runDigestPipeline: trace("digest", runDigestPipeline),
      generateReferencesCandidates: async options => { if (scenario.referencesFailure) throw new Error("fixture"); return generateReferencesCandidates(options); },
      runReferencesSelectionPipeline: async options => { if (scenario.selectionFailure) throw new Error("fixture"); return runReferencesSelectionPipeline(options); },
    },
  };
  if (ctx.stageId === "validate-edition" && scenario.finalNow) dependencies.now = () => scenario.finalNow;
  return executePipelineStage(ctx, dependencies);
}
