import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runDaily, loadDailyConfig, validateConfig } from "../src/daily/run.js";
import { acquireLock, releaseLock, recoverLock } from "../src/daily/lock.js";
import { createState, writeState } from "../src/daily/state.js";
import { runDailyCli } from "../src/daily.js";

const at = "2026-09-21T08:15:00.000Z", id = "20260921T081500Z", now = () => at;
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "data/daily");
  return { dir, root, config: loadDailyConfig(), now };
}
function adapter(ctx, name, body) {
  const file = path.join(ctx.dir, `${name}.mjs`);
  fs.writeFileSync(file, `import fs from 'node:fs';\nexport default async function(ctx) { ${body} }`);
  return { id: name, moduleUrl: pathToFileURL(file).href };
}
function readState(ctx) { return JSON.parse(fs.readFileSync(path.join(ctx.root, "runs", id, "run.json"), "utf8")); }
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  throw new Error("Timed out waiting for fixture");
}

test("daily success uses isolated explicit paths; canonical sentinel files unchanged", async t => {
  const ctx = setup(t);
  for (const folder of ["normalized", "processed"]) {
    fs.mkdirSync(path.join(ctx.dir, "data", folder), { recursive: true });
    fs.writeFileSync(path.join(ctx.dir, "data", folder, "sentinel.json"), "preserve");
  }
  const first = adapter(ctx, "ingest", `ctx.writeJson('normalized/input.json', {runId:ctx.runId}); return {status:'succeeded'};`);
  const second = adapter(ctx, "unify", `const data=JSON.parse(fs.readFileSync(ctx.inputs.pool)); ctx.writeJson('processed/output.json', data); return {status:'succeeded'};`);
  second.inputs = { pool: "normalized/input.json" };
  second.outputs = { pool: "processed/output.json" };
  const result = await runDaily({ ...ctx, stages: [first, second] });
  assert.equal(result.state.status, "succeeded");
  assert.equal(result.workDir, path.join(ctx.root, "runs", id, "work"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.workDir, "processed/output.json"))).runId, id);
  assert.deepEqual(readState(ctx), result.state);
  assert.ok(result.state.stages.every(s => s.startedAt === at && s.finishedAt === at));
  assert.equal(fs.existsSync(path.join(ctx.root, "lock")), false);
  for (const folder of ["normalized", "processed"]) assert.equal(fs.readFileSync(path.join(ctx.dir, "data", folder, "sentinel.json"), "utf8"), "preserve");
});

test("daily degraded and skipped adapters persist truthful terminal statuses", async t => {
  const ctx = setup(t);
  const stages = [adapter(ctx, "degrade", `return {status:'degraded'};`), adapter(ctx, "skip", `return {status:'skipped'};`), { id: "disabled", skip: true }];
  const { state } = await runDaily({ ...ctx, stages });
  assert.equal(state.status, "succeeded_degraded");
  assert.deepEqual(state.summary.degraded, ["degrade"]);
  assert.deepEqual(state.stages.map(s => s.status), ["degraded", "skipped", "skipped"]);
  assert.equal(state.stages[2].startedAt, null);
});

for (const [name, body, diagnostic] of [
  ["throw", `throw new Error('secret-key-value');`, "stage_failed"],
  ["failure", `return {status:'failed'};`, "stage_failed"],
  ["nonzero", `process.exit(7);`, "worker_exit"],
  ["empty", `process.exit(0);`, "invalid_result"],
  ["invalid", `return {status:'banana'};`, "invalid_result"],
]) test(`daily ${name} cannot mark success and skips downstream`, async t => {
  const ctx = setup(t);
  const { state } = await runDaily({ ...ctx, stages: [adapter(ctx, name, body), { id: "later", moduleUrl: null }] });
  assert.equal(state.status, "failed");
  assert.equal(state.stages[0].diagnostic, diagnostic);
  assert.equal(state.stages[1].status, "skipped");
  assert.equal(JSON.stringify(state).includes("secret-key-value"), false);
  assert.equal(fs.existsSync(path.join(ctx.root, "lock")), false);
});

test("daily stage deadline terminates worker even after premature success result", async t => {
  const ctx = setup(t);
  ctx.config.execution.stageDeadlineMs = 1000;
  const stage = adapter(ctx, "hang", `setInterval(()=>ctx.writeJson('heartbeat.json', {at:Date.now()}), 10); return {status:'succeeded'};`);
  const { state, workDir } = await runDaily({ ...ctx, stages: [stage] });
  assert.equal(state.status, "failed");
  assert.equal(state.stages[0].diagnostic, "stage_deadline");
  const heartbeat = path.join(workDir, "heartbeat.json");
  const bytes = fs.readFileSync(heartbeat, "utf8");
  await delay(60);
  assert.equal(fs.readFileSync(heartbeat, "utf8"), bytes);
});

test("daily whole-run deadline terminates worker and skips remaining work", async t => {
  const ctx = setup(t);
  ctx.config.execution.runDeadlineMs = 150;
  const stage = adapter(ctx, "loop", `while(true) {}`);
  const { state } = await runDaily({ ...ctx, stages: [stage, { id: "later", moduleUrl: null }] });
  assert.equal(state.status, "failed");
  assert.equal(state.stages[0].diagnostic, "run_deadline");
  assert.equal(state.stages[1].status, "skipped");
});

test("daily active second runner refuses, then handled interruption persists and releases", async t => {
  const ctx = setup(t), controller = new AbortController();
  const stage = adapter(ctx, "active", `ctx.writeJson('ready.json', {}); await new Promise(()=>{});`);
  // Keep the worker event loop alive, as an unresolved promise alone may exit.
  fs.appendFileSync(fileURLToPath(stage.moduleUrl), '\nsetInterval(()=>{},1000);\n');
  const first = runDaily({ ...ctx, stages: [stage], signal: controller.signal });
  await until(() => fs.existsSync(path.join(ctx.root, "runs", id, "work", "ready.json")));
  assert.equal(readState(ctx).stages[0].status, "running");
  await assert.rejects(runDaily({ ...ctx, stages: [{ id: "other", moduleUrl: null }] }), /lock exists/);
  controller.abort();
  const { state } = await first;
  assert.equal(state.status, "interrupted");
  assert.equal(state.stages[0].diagnostic, "interrupted");
  assert.equal(fs.existsSync(path.join(ctx.root, "lock")), false);
});

test("daily same-second identity collision preserves previous history", async t => {
  const ctx = setup(t), stages = [{ id: "foundation", moduleUrl: null }];
  await runDaily({ ...ctx, stages });
  const before = readState(ctx);
  await assert.rejects(runDaily({ ...ctx, stages }), /EEXIST/);
  assert.deepEqual(readState(ctx), before);
  assert.equal(fs.existsSync(path.join(ctx.root, "lock")), false);
  const next = await runDaily({ ...ctx, stages, now: () => "2026-09-21T08:15:01Z" });
  assert.notEqual(next.state.runId, id);
});

test("daily malformed paths record handled failure without overwriting canonical files", async t => {
  const ctx = setup(t);
  await assert.rejects(runDaily({ ...ctx, stages: [{ id: "unsafe", moduleUrl: null, outputs: { pool: "../../../normalized/pool.json" } }] }), /relative/);
  assert.equal(readState(ctx).status, "failed");
  assert.equal(readState(ctx).stages[0].diagnostic, "runner_failed");
  assert.equal(fs.existsSync(path.join(ctx.root, "lock")), false);
});

test("daily lock only releases its unique owner token; age never permits takeover", t => {
  const ctx = setup(t), lease = acquireLock(ctx.root, id, now);
  assert.throws(() => acquireLock(ctx.root, id, () => "2099-01-01Z"), /lock exists/);
  assert.throws(() => releaseLock({ ...lease, token: "wrong" }), /ownership/);
  assert.throws(() => recoverLock(ctx.root), /Live or uncertain/);
  releaseLock(lease);
  assert.equal(fs.existsSync(lease.lock), false);
});

test("daily explicit recovery of real dead local owner marks abandoned run interrupted", t => {
  const ctx = setup(t);
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
  assert.equal(child.status, 0);
  const lease = acquireLock(ctx.root, id, now);
  const ownerFile = path.join(lease.lock, "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile));
  owner.pid = child.pid;
  fs.writeFileSync(ownerFile, JSON.stringify(owner));
  const runDir = path.join(ctx.root, "runs", id);
  fs.mkdirSync(runDir, { recursive: true });
  const state = createState(id, at, ["pending"], 30);
  writeState(path.join(runDir, "run.json"), state);
  assert.throws(() => acquireLock(ctx.root, id, now), /lock exists/);
  recoverLock(ctx.root, { now });
  assert.equal(readState(ctx).status, "interrupted");
  assert.equal(readState(ctx).stages[0].status, "skipped");
  const next = acquireLock(ctx.root, id, now);
  releaseLock(next);
});

test("daily uncertain and remote owner recovery refuses and preserves metadata", t => {
  const ctx = setup(t), lease = acquireLock(ctx.root, id, now);
  const file = path.join(lease.lock, "owner.json"), original = fs.readFileSync(file, "utf8");
  assert.throws(() => recoverLock(ctx.root, { probe() { throw Object.assign(new Error(), { code: "EPERM" }); } }), /uncertain/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), hostname: "remote-host.invalid" }));
  assert.throws(() => recoverLock(ctx.root), /Uncertain/);
  fs.writeFileSync(file, "{}");
  assert.throws(() => recoverLock(ctx.root), /Uncertain/);
  fs.unlinkSync(file);
  assert.throws(() => recoverLock(ctx.root), /ENOENT/);
  assert.ok(fs.existsSync(lease.lock));
});

test("daily rejects missing stages and invalid execution policy before creating runtime data", async t => {
  const ctx = setup(t);
  await assert.rejects(runDaily(ctx), /explicit stages/);
  ctx.config.execution.stageDeadlineMs = 0;
  assert.throws(() => validateConfig(ctx.config), /Invalid/);
  assert.equal(fs.existsSync(ctx.root), false);
});

test("daily invalid CLI refuses execution and runtime is gitignored", async () => {
  let output = "";
  const code = await runDailyCli(["--unknown"], { stderr: { write(s) { output += s; } } });
  assert.equal(code, 1);
  assert.match(output, /Usage/);
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const ignored = spawnSync("git", ["check-ignore", "data/daily/lock/owner.json", `data/daily/runs/${id}/run.json`, `data/daily/runs/${id}/work/file.json`], { cwd: repo, encoding: "utf8" });
  assert.equal(ignored.status, 0);
  assert.equal(ignored.stdout.trim().split('\n').length, 3);
});

test("candidate worker timeout removes a prematurely written manifest", async t => {
  const ctx = setup(t);
  ctx.config.execution.stageDeadlineMs = 500;
  const stage = adapter(ctx, "premature", `ctx.writeJson('edition/manifest.json', {status:'validated'}); setInterval(()=>{},1000); return {status:'succeeded'};`);
  const result = await runDaily({ ...ctx, mode: "candidate", stages: [stage] });
  assert.equal(result.state.status, "failed");
  assert.equal(fs.existsSync(path.join(result.workDir, "edition/manifest.json")), false);
});

test("recovery invalidates an interrupted candidate manifest", t => {
  const ctx = setup(t);
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(child.status, 0);
  const lease = acquireLock(ctx.root, id, now);
  const ownerFile = path.join(lease.lock, "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile)); owner.pid = child.pid;
  fs.writeFileSync(ownerFile, JSON.stringify(owner));
  const runDir = path.join(ctx.root, "runs", id);
  fs.mkdirSync(path.join(runDir, "work/edition"), { recursive: true });
  const state = createState(id, at, ["pending"], 30); state.mode = "candidate";
  writeState(path.join(runDir, "run.json"), state);
  const marker = path.join(runDir, "work/edition/manifest.json");
  fs.writeFileSync(marker, '{"status":"validated"}');
  recoverLock(ctx.root, { now });
  assert.equal(readState(ctx).status, "interrupted");
  assert.equal(fs.existsSync(marker), false);
});
