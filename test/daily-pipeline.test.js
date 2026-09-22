import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProductionDaily } from "../src/daily/pipeline.js";
import { loadDailyConfig } from "../src/daily/run.js";
import { runDailyCli } from "../src/daily.js";
import { validateEditionCandidate, hashBytes } from "../src/daily/edition.js";
import { FILES, STAGE_ORDER } from "../src/daily/contract.js";

const NOW = "2026-09-21T15:30:00.000Z";
const moduleUrl = new URL("./fixtures/daily/adapter.js", import.meta.url).href;
function source(id, itemTitle) {
  return { id, url: `https://${id}.invalid/feed`, xml: `<rss version="2.0"><channel><title>${id}</title><lastBuildDate>${NOW}</lastBuildDate><item><guid>${id}-1</guid><title>${itemTitle}</title><link>https://${id}.invalid/story</link><pubDate>${NOW}</pubDate><description>Fixture facts</description></item></channel></rss>` };
}
function scenario() {
  const item = JSON.parse(fs.readFileSync(new URL("./fixtures/valid-10.json", import.meta.url))).items[0];
  return {
    x: { schemaVersion: 1, source: "x-timeline-collector", generatedAt: NOW, collectionCompletedAt: NOW,
      scope: { type: "collect-run", itemCount: 1 }, items: [{ ...item, title: "NASA announces a new lunar research mission", postedAt: NOW, collectedAt: NOW,
        media: [{ type: "image", url: "https://pbs.twimg.com/media/fixture", previewUrl: null, width: 800, height: 600, altText: "Fixture image" }],
        visual: { value: 4, roles: ["reference"] }, vision: null }] },
    web: [source("science", "NASA announces plans for a lunar research mission"), source("world", "International meeting agrees new economic measures")],
  };
}
function setup(t, edit = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-pipeline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "data/daily");
  fs.mkdirSync(root, { recursive: true });
  for (const folder of ["normalized", "processed", "cache"]) {
    fs.mkdirSync(path.join(dir, "data", folder));
    fs.writeFileSync(path.join(dir, "data", folder, "preserve.json"), '{"preserve":true}');
  }
  fs.writeFileSync(path.join(root, "current.json"), '{"previous":"known-good"}');
  const value = scenario(); edit(value);
  fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(value));
  const config = loadDailyConfig(); config.fetch.timeoutMs = 100;
  return { root, dir, config, now: () => NOW, moduleUrl };
}
function read(result, key) { return JSON.parse(fs.readFileSync(path.join(result.workDir, FILES[key]), "utf8")); }
function ctx(result, config) { return { runId: result.state.runId, startedAt: result.state.startedAt, workDir: result.workDir, stages: result.state.stages, config }; }
function unchanged(env) {
  for (const folder of ["normalized", "processed", "cache"]) assert.equal(fs.readFileSync(path.join(env.dir, "data", folder, "preserve.json"), "utf8"), '{"preserve":true}');
  assert.equal(fs.readFileSync(path.join(env.root, "current.json"), "utf8"), '{"previous":"known-good"}');
}
function assertFailed(result, stage, diagnostic) {
  assert.equal(result.state.status, "failed", JSON.stringify(result.state.stages));
  const failed = result.state.stages.find(s => s.id === stage);
  assert.equal(failed.status, "failed");
  if (diagnostic) assert.ok(failed.diagnostics.includes(diagnostic), JSON.stringify(failed));
  assert.ok(result.state.stages.slice(STAGE_ORDER.indexOf(stage) + 1).every(s => s.status === "skipped"));
  assert.equal(fs.existsSync(path.join(result.workDir, FILES.manifest)), false);
}

test("production adapters run real isolated pipeline in order with fake fetch/AI and validate a bound candidate", async t => {
  const env = setup(t, s => { s.checkEnvironment = true; });
  const result = await runProductionDaily({ ...env, workerEnv: { OPENAI_API_KEY: "test-only-credential", UNRELATED_SECRET: "never-forward-this" } });
  assert.equal(result.state.status, "succeeded", JSON.stringify(result.state.stages));
  assert.equal(result.state.mode, "candidate");
  assert.deepEqual(result.state.stages.map(s => s.id), STAGE_ORDER);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.workDir, "calls.json"))).map(s => s.stage), STAGE_ORDER);
  for (const stage of ["semantic", "evaluate", "digest"]) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.workDir, `${stage}-options.json`))), { applyAi: true, requestLimit: null });
  assert.ok(read(result, "digest").items.length >= 2);
  assert.equal(read(result, "references").stats.selected, 1);
  const manifest = await validateEditionCandidate(ctx(result, env.config), { now: NOW });
  assert.equal(manifest.editionDate, "2026-09-22");
  assert.equal(manifest.runId, result.state.runId);
  assert.equal(manifest.inputs.x.collectionCompletedAt, NOW);
  for (const descriptor of Object.values(manifest.files)) assert.equal(descriptor.sha256, hashBytes(fs.readFileSync(path.join(result.workDir, descriptor.path))));
  for (const file of walk(result.runDir)) {
    const content = fs.readFileSync(file, "utf8");
    assert.equal(content.includes("test-only-credential"), false);
    assert.equal(content.includes("never-forward-this"), false);
  }
  unchanged(env);
  const manifestBytes = fs.readFileSync(path.join(result.workDir, FILES.manifest), "utf8");
  await assert.rejects(runProductionDaily(env), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(result.workDir, FILES.manifest), "utf8"), manifestBytes);
});
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }

test("empty verified X succeeds with same-run Web; empty References is recorded as degraded", async t => {
  const env = setup(t, s => { s.x.items = []; s.x.scope.itemCount = 0; });
  const result = await runProductionDaily(env);
  assert.equal(result.state.status, "succeeded_degraded", JSON.stringify(result.state.stages));
  assert.equal(read(result, "xReceipt").itemCount, 0);
  assert.equal(read(result, "references").items.length, 0);
  assert.deepEqual(result.state.summary.degraded, ["references"]);
  unchanged(env);
});

for (const [name, edit, expected] of [
  ["fetch failure", s => { s.x.failure = "http"; }, "fetch_http"],
  ["malformed JSON", s => { s.xMalformed = true; }, "x_schema_invalid"],
  ["count mismatch", s => { s.x.scope.itemCount = 99; }, "x_schema_invalid"],
  ["null provenance", s => { s.x.collectionCompletedAt = null; }, "x_collection_unverified"],
]) test(`X ${name} fails before Web or AI without cached fallback`, async t => {
  const env = setup(t, edit);
  const result = await runProductionDaily(env);
  assertFailed(result, "ingest:x", expected);
  unchanged(env);
});

for (const failure of ["http", "source", "timeout", "malformed"]) test(`individual Web ${failure} failure degrades with successful remaining source`, async t => {
  const env = setup(t, s => { if (failure === "malformed") s.web[0].xml = "not a feed"; else s.web[0].failure = failure; });
  const result = await runProductionDaily(env);
  assert.equal(result.state.status, "succeeded_degraded", JSON.stringify(result.state.stages));
  const web = read(result, "webReceipt");
  assert.equal(web.sources.filter(s => s.status === "succeeded").length, 1);
  assert.ok(result.state.summary.degraded.includes("ingest:web"));
  unchanged(env);
});

test("all Web failures are required failures; old metadata is only degradation", async t => {
  const failedEnv = setup(t, s => { s.web.forEach(w => { w.failure = "http"; }); });
  assertFailed(await runProductionDaily(failedEnv), "ingest:web", "web_all_failed");
  const oldEnv = setup(t, s => { s.web[0].xml = s.web[0].xml.replace(`<lastBuildDate>${NOW}</lastBuildDate>`, "<lastBuildDate>2026-09-01T00:00:00Z</lastBuildDate>"); });
  const result = await runProductionDaily(oldEnv);
  assert.equal(result.state.status, "succeeded_degraded", JSON.stringify(result.state.stages));
  assert.ok(read(result, "manifest").degradedDiagnostics.some(s => s.codes.includes("web_metadata_old")));
});

for (const stage of ["semantic", "evaluate", "digest"]) test(`${stage} AI required failure cannot produce a candidate or leak credential diagnostics`, async t => {
  const env = setup(t, s => { s.aiFailure = stage; });
  const result = await runProductionDaily(env);
  assertFailed(result, stage, stage === "semantic" ? "semantic_incomplete" : stage === "evaluate" ? "evaluation_incomplete" : "digest_failed");
  for (const file of walk(result.runDir)) assert.equal(fs.readFileSync(file, "utf8").includes("test-only-credential"), false);
  unchanged(env);
});

for (const stage of ["semantic", "evaluate"]) test(`${stage} incomplete results fail even with successful individual calls`, async t => {
  const env = setup(t, s => { s.incomplete = stage; });
  assertFailed(await runProductionDaily(env), stage);
});

test("Digest per-item fallback preserves a valid degraded candidate", async t => {
  const env = setup(t, s => { s.digestFallback = true; });
  const result = await runProductionDaily(env);
  assert.equal(result.state.status, "succeeded_degraded", JSON.stringify(result.state.stages));
  assert.ok(read(result, "digest").items.some(item => item.status === "failed"));
  assert.ok(read(result, "digest").items.some(item => item.status === "ok"));
  assert.ok(read(result, "manifest").degradedDiagnostics.some(s => s.codes.includes("digest_fallback")));
});

for (const [flag, stage] of [["referencesFailure", "references"], ["selectionFailure", "references:select"]]) test(`${stage} failure is required`, async t => {
  const env = setup(t, s => { s[flag] = true; });
  assertFailed(await runProductionDaily(env), stage);
});

test("freshness recheck rejects a collection that ages out during processing", async t => {
  const env = setup(t, s => { s.x.collectionCompletedAt = "2026-09-20T03:30:00Z"; s.finalNow = "2026-09-21T15:30:01Z"; });
  const result = await runProductionDaily(env);
  assertFailed(result, "validate-edition", "x_collection_stale");
  unchanged(env);
});

test("successful cache seeds are private; cache hits are AI success and leave seeds unchanged", async t => {
  const env = setup(t);
  const first = await runProductionDaily(env);
  assert.equal(first.state.status, "succeeded", JSON.stringify(first.state.stages));
  const secondEnv = setup(t, s => { s.noAiCalls = true; });
  const snapshots = {};
  for (const [kind, key] of [["semantic", "semanticCache"], ["evaluation", "evaluationCache"], ["digest", "digestCache"]]) {
    const file = path.join(secondEnv.root, `${kind}-seed.json`);
    fs.copyFileSync(path.join(first.workDir, FILES[key]), file);
    snapshots[file] = fs.readFileSync(file, "utf8");
  }
  const second = await runProductionDaily(secondEnv);
  assert.equal(second.state.status, "succeeded", JSON.stringify(second.state.stages));
  for (const key of ["semantic", "evaluated", "digest"]) {
    assert.equal(read(second, key).stats.judgeCalls, 0);
    assert.ok(read(second, key).stats.cacheHits > 0);
  }
  for (const [file, bytes] of Object.entries(snapshots)) assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("candidate validator rejects invalid contracts, missing files, hashes, run mismatch and escapes", async t => {
  const env = setup(t), result = await runProductionDaily(env);
  assert.equal(result.state.status, "succeeded", JSON.stringify(result.state.stages));
  const context = ctx(result, env.config);
  const all = Object.fromEntries(walk(result.workDir).map(file => [file, fs.readFileSync(file)]));
  const restore = () => { for (const [file, bytes] of Object.entries(all)) fs.writeFileSync(file, bytes); };
  const manifestPath = path.join(result.workDir, FILES.manifest);
  for (const mutate of [
    m => { m.runId = "another-run"; }, m => { m.files.digest.sha256 = "bad"; },
    m => { m.files.references.path = "../../outside.json"; }, m => { m.editionDate = "2026-09-21"; },
  ]) {
    const manifest = read(result, "manifest"); mutate(manifest); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(validateEditionCandidate(context, { now: NOW })); restore();
  }
  fs.unlinkSync(path.join(result.workDir, FILES.editionMarkdown));
  await assert.rejects(validateEditionCandidate(context, { now: NOW })); restore();
  // Rebind hashes after corruption to ensure contract validation itself rejects it.
  for (const [key, mutate] of [
    ["digest", d => { d.items[0].rank = 999; }],
    ["references", d => { d.stats.selected = 999; }],
  ]) {
    const alteredContext = structuredClone(context);
    const document = read(result, key); mutate(document);
    const file = path.join(result.workDir, FILES[key]); fs.writeFileSync(file, JSON.stringify(document));
    const artifact = alteredContext.stages.flatMap(s => s.artifacts ?? []).find(a => a.path === FILES[key]);
    artifact.sha256 = hashBytes(fs.readFileSync(file));
    await assert.rejects(validateEditionCandidate(alteredContext, { now: NOW })); restore();
  }
  const alteredContext = structuredClone(context); alteredContext.stages[0].status = "skipped";
  await assert.rejects(validateEditionCandidate(alteredContext, { now: NOW }));
  await assert.rejects(validateEditionCandidate({ ...context, runId: "other" }, { now: NOW }));
  unchanged(env);
});

test("CLI dispatch and exit codes are tested only with injected local runner", async t => {
  const env = setup(t);
  let output = "";
  for (const [status, expected] of [["succeeded", 0], ["succeeded_degraded", 2], ["failed", 1]]) {
    const code = await runDailyCli([], { root: env.root, environment: {}, stdout: { write(s) { output += s; } },
      productionRunner: async options => { assert.equal(options.root, env.root); return { state: { status, runId: "fixture" } }; } });
    assert.equal(code, expected);
  }
  assert.match(output, /candidate only/);
  assert.match(output, /no promotion/);
  const other = setup(t); fs.unlinkSync(path.join(other.root, "current.json"));
  const result = await runProductionDaily(other);
  assert.equal(result.state.status, "succeeded", JSON.stringify(result.state.stages));
  assert.equal(fs.existsSync(path.join(other.root, "current.json")), false);
});
