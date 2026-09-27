import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runProductionDaily } from "../src/daily/pipeline.js";
import { loadDailyConfig } from "../src/daily/run.js";
import { promoteRun } from "../src/daily/promotion.js";
import { readCurrentPublication, hashBytes } from "../src/daily/edition.js";
import { acquireLock, recoverLock } from "../src/daily/lock.js";
import { writeState } from "../src/daily/state.js";
import { FILES, EDITION_FILES } from "../src/daily/contract.js";

const AT = "2026-09-24T00:00:00.000Z";
const adapter = new URL("./fixtures/daily/adapter.js", import.meta.url).href;
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-promotion-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "data/daily");
  fs.mkdirSync(root, { recursive: true });
  for (const folder of ["normalized", "processed"]) {
    fs.mkdirSync(path.join(dir, "data", folder));
    fs.writeFileSync(path.join(dir, "data", folder, "canonical.json"), "unchanged");
  }
  const item = JSON.parse(fs.readFileSync(new URL("./fixtures/valid-10.json", import.meta.url))).items[0];
  const scenario = {
    x: { schemaVersion: 1, source: "x-timeline-collector", generatedAt: AT, collectionCompletedAt: AT,
      scope: { itemCount: 1 }, items: [{ ...item, postedAt: AT, collectedAt: AT,
        media: [{ type: "image", url: "https://pbs.twimg.com/media/fixture" }], visual: { value: 4, roles: ["reference"] } }] },
    web: [{ id: "fixture", url: "https://fixture.invalid/rss", xml: `<rss><channel><title>Fixture</title><lastBuildDate>${AT}</lastBuildDate><item><guid>a</guid><title>International talks conclude with new agreement</title><link>https://fixture.invalid/a</link><pubDate>${AT}</pubDate></item></channel></rss>` }],
  };
  fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(scenario));
  return { root, dir, config: loadDailyConfig() };
}
const at = seconds => new Date(Date.parse(AT) + seconds * 1000).toISOString();
async function candidate(env, seconds = 0, extra = {}) {
  const result = await runProductionDaily({ ...env, moduleUrl: adapter, now: () => at(seconds), promote: false, ...extra });
  assert.ok(["succeeded", "succeeded_degraded"].includes(result.state.status), JSON.stringify(result.state));
  return result;
}
function promote(env, result, options = {}) {
  return promoteRun({ root: env.root, config: env.config, runId: result.state.runId,
    now: () => at(10), ...options });
}
function pointerBytes(env) { return fs.readFileSync(path.join(env.root, "current.json")); }
function stateOf(result) { return JSON.parse(fs.readFileSync(path.join(result.runDir, "run.json"))); }
function editionDir(env, result) { return path.join(env.root, "editions", result.state.runId); }
async function pair(t) {
  const env = setup(t), old = await candidate(env);
  const initial = await promote(env, old);
  assert.equal(initial.committed, true, JSON.stringify(initial));
  const current = pointerBytes(env);
  const next = await candidate(env, 1);
  return { env, old, next, current };
}
function assertProtected(env, current) {
  assert.deepEqual(pointerBytes(env), current);
  assert.ok(readCurrentPublication(env.root));
  for (const folder of ["normalized", "processed"]) assert.equal(fs.readFileSync(path.join(env.dir, "data", folder, "canonical.json"), "utf8"), "unchanged");
}
function assertNoTemporary(env) {
  assert.ok(!fs.readdirSync(env.root).some(n => n.endsWith(".tmp")));
  const editions = path.join(env.root, "editions");
  if (fs.existsSync(editions)) assert.ok(!fs.readdirSync(editions).some(n => n.endsWith(".tmp")));
}

test("valid promotion creates exact immutable edition and atomically switches pointer; old bytes remain", async t => {
  const { env, old, next, current } = await pair(t);
  const previousFiles = Object.fromEntries(EDITION_FILES.map(n => [n, fs.readFileSync(path.join(editionDir(env, old), n))]));
  const fd = fs.openSync(path.join(env.root, "current.json"), "r");
  let sawPublishing = false;
  const result = await promote(env, next, { checkpoint(name) {
    if (name === "before-pointer-rename") {
      assertProtected(env, current);
      assert.equal(stateOf(next).status, "publishing");
      sawPublishing = true;
    }
  } });
  try { assert.deepEqual(fs.readFileSync(fd), current); } finally { fs.closeSync(fd); }
  assert.equal(sawPublishing, true);
  assert.equal(result.committed, true, JSON.stringify(result));
  assert.equal(stateOf(next).status, "succeeded");
  assert.equal(stateOf(next).publication.status, "committed");
  const publication = readCurrentPublication(env.root);
  assert.equal(publication.pointer.runId, next.state.runId);
  assert.equal(publication.pointer.edition, `editions/${next.state.runId}`);
  assert.equal(publication.pointer.manifestSha256, hashBytes(fs.readFileSync(path.join(editionDir(env, next), "manifest.json"))));
  assert.deepEqual(fs.readdirSync(editionDir(env, next)).sort(), [...EDITION_FILES].sort());
  for (const name of EDITION_FILES) {
    assert.deepEqual(fs.readFileSync(path.join(editionDir(env, old), name)), previousFiles[name]);
    assert.deepEqual(fs.readFileSync(path.join(editionDir(env, next), name)), fs.readFileSync(path.join(next.workDir, "edition", name)));
  }
  assertNoTemporary(env);
});

test("normal production orchestration promotes while holding its original lock; degraded run remains degraded", async t => {
  const env = setup(t);
  const scenario = JSON.parse(fs.readFileSync(path.join(env.root, "fixture.json")));
  scenario.x.items[0].visual = null;
  fs.writeFileSync(path.join(env.root, "fixture.json"), JSON.stringify(scenario));
  const result = await runProductionDaily({ ...env, moduleUrl: adapter, now: () => AT });
  assert.equal(result.publication.committed, true, JSON.stringify(result));
  assert.equal(result.state.status, "succeeded_degraded");
  assert.equal(stateOf(result).status, "succeeded_degraded");
  assert.equal(readCurrentPublication(env.root).pointer.runId, result.state.runId);
  assert.equal(fs.existsSync(path.join(env.root, "lock")), false);
});

for (const [label, mutate] of [
  ["manifest invalid", result => { fs.writeFileSync(path.join(result.workDir, FILES.manifest), "{}"); }],
  ["Digest malformed", result => { fs.writeFileSync(path.join(result.workDir, FILES.editionDigest), "{"); }],
  ["References malformed", result => { fs.writeFileSync(path.join(result.workDir, FILES.editionReferences), "{"); }],
  ["hash mismatch", result => { fs.appendFileSync(path.join(result.workDir, FILES.editionMarkdown), "changed"); }],
  ["missing candidate", result => { fs.unlinkSync(path.join(result.workDir, FILES.editionDigest)); }],
  ["required stage failure", result => { const state = stateOf(result); state.stages[4].status = "failed"; writeState(path.join(result.runDir, "run.json"), state); }],
  ["failed run", result => { const state = stateOf(result); state.status = "failed"; writeState(path.join(result.runDir, "run.json"), state); }],
  ["interrupted run", result => { const state = stateOf(result); state.status = "interrupted"; writeState(path.join(result.runDir, "run.json"), state); }],
  ["null collection provenance", result => {
    const file = path.join(result.workDir, FILES.xReceipt), receipt = JSON.parse(fs.readFileSync(file)); receipt.collectionCompletedAt = null;
    fs.writeFileSync(file, JSON.stringify(receipt));
  }],
]) test(`${label} cannot replace known-good`, async t => {
  const { env, next, current } = await pair(t);
  mutate(next);
  const result = await promote(env, next);
  assert.equal(result.committed, false);
  assert.equal(stateOf(next).status, "failed");
  assertProtected(env, current);
  assert.equal(fs.existsSync(editionDir(env, next)), false);
  assertNoTemporary(env);
});

test("X age is checked at promotion and again at the last commit boundary", async t => {
  for (const delayed of [false, true]) {
    const { env, next, current } = await pair(t);
    let time = delayed ? at(10) : at(36 * 3600 + 1);
    const result = await promote(env, next, { now: () => time, checkpoint(name) {
      if (name === "before-pointer-rename") time = at(36 * 3600 + 1);
    } });
    assert.equal(result.committed, false);
    assert.equal(result.diagnostic, "x_collection_stale");
    assertProtected(env, current);
  }
});

for (const boundary of ["before-materialize", "edition-file-written", "before-edition-rename", "after-edition-rename", "pointer-written", "before-pointer-rename"]) {
  test(`failure at ${boundary} keeps old pointer; no partial edition published`, async t => {
    const { env, next, current } = await pair(t);
    const result = await promote(env, next, { checkpoint(name) { if (name === boundary) throw new Error("injected failure"); } });
    assert.equal(result.committed, false);
    assert.equal(stateOf(next).status, "failed");
    assertProtected(env, current);
    if (fs.existsSync(editionDir(env, next))) assert.deepEqual(fs.readdirSync(editionDir(env, next)).sort(), [...EDITION_FILES].sort());
    assertNoTemporary(env);
  });
}

test("copied edition and temporary pointer are validated, not merely written", async t => {
  for (const artifact of ["edition", "pointer"]) {
    const { env, next, current } = await pair(t);
    const result = await promote(env, next, { checkpoint(name, details) {
      if (artifact === "edition" && name === "edition-file-written" && details.name === "references.json") fs.writeFileSync(path.join(details.directory, details.name), "{}");
      if (artifact === "pointer" && name === "pointer-written") fs.writeFileSync(details.file, "{}");
    } });
    assert.equal(result.committed, false);
    assertProtected(env, current);
    assertNoTemporary(env);
  }
});

test("failure immediately after pointer rename is committed and recoverable without rollback", async t => {
  const { env, next } = await pair(t);
  const result = await promote(env, next, { checkpoint(name) { if (name === "after-pointer-rename") throw new Error("simulated crash after commit"); } });
  assert.equal(result.committed, true);
  assert.equal(result.bookkeeping, "pending");
  assert.equal(stateOf(next).status, "publishing");
  const current = pointerBytes(env);
  assert.equal(readCurrentPublication(env.root).pointer.runId, next.state.runId);
  // No lock exists after handled failure: --recover-lock can reconcile truth.
  assert.equal(recoverLock(env.root).reconciled, true);
  assert.equal(stateOf(next).status, "succeeded");
  assert.equal(stateOf(next).publication.bookkeeping, "succeeded");
  assert.deepEqual(pointerBytes(env), current);
});

test("terminal state write failure cannot turn a committed publication into failure", async t => {
  const { env, next } = await pair(t);
  const result = await promote(env, next, { persist(file, state) {
    if (state.publication?.status === "committed") throw new Error("disk error on bookkeeping");
    writeState(file, state);
  } });
  assert.equal(result.committed, true);
  assert.equal(result.bookkeeping, "pending");
  assert.equal(stateOf(next).status, "publishing");
  assert.equal(readCurrentPublication(env.root).pointer.runId, next.state.runId);
  const again = await promote(env, next);
  assert.equal(again.idempotent, true);
  assert.equal(stateOf(next).status, "succeeded");
});

test("dead-owner recovery recognizes committed publication even with interrupted bookkeeping", async t => {
  const { env, next } = await pair(t);
  await promote(env, next, { checkpoint(name) { if (name === "after-pointer-rename") throw new Error("crash"); } });
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(child.status, 0);
  const lease = acquireLock(env.root, next.state.runId, () => AT);
  const file = path.join(lease.lock, "owner.json"), owner = JSON.parse(fs.readFileSync(file)); owner.pid = child.pid;
  fs.writeFileSync(file, JSON.stringify(owner));
  recoverLock(env.root);
  assert.equal(stateOf(next).status, "succeeded");
  assert.equal(stateOf(next).publication.status, "committed");
  assert.ok(fs.existsSync(path.join(next.workDir, FILES.manifest)));
  assert.equal(fs.existsSync(lease.lock), false);
});

test("already-current run is idempotent; no new freshness claim or timestamp refresh", async t => {
  const env = setup(t), next = await candidate(env);
  assert.equal((await promote(env, next)).committed, true);
  const current = pointerBytes(env);
  // Reconciliation of an existing publication is not a new stale promotion.
  const result = await promote(env, next, { now: () => at(7 * 86400) });
  assert.equal(result.committed, true);
  assert.equal(result.idempotent, true);
  assert.deepEqual(pointerBytes(env), current);
});

test("equivalent existing edition is reused without writes; conflicting/empty edition is never overwritten", async t => {
  for (const conflict of [false, true, "empty"]) {
    const { env, next, current } = await pair(t);
    const edition = editionDir(env, next);
    fs.mkdirSync(edition);
    if (conflict !== "empty") for (const name of EDITION_FILES) fs.copyFileSync(path.join(next.workDir, "edition", name), path.join(edition, name));
    if (conflict === true) fs.writeFileSync(path.join(edition, "references.json"), "{}");
    const contents = Object.fromEntries(fs.readdirSync(edition).map(name => [name, fs.readFileSync(path.join(edition, name))]));
    const inodes = Object.fromEntries(fs.readdirSync(edition).map(name => [name, fs.statSync(path.join(edition, name)).ino]));
    const result = await promote(env, next);
    assert.equal(result.committed, !conflict);
    if (conflict) { assert.equal(result.diagnostic, "edition_conflict"); assertProtected(env, current); }
    for (const [name, bytes] of Object.entries(contents)) {
      assert.deepEqual(fs.readFileSync(path.join(edition, name)), bytes);
      assert.equal(fs.statSync(path.join(edition, name)).ino, inodes[name]);
    }
    assert.deepEqual(fs.readdirSync(edition).sort(), Object.keys(contents).sort());
  }
});

for (const [label, mutate, diagnostic] of [
  ["malformed", (p, env) => fs.writeFileSync(path.join(env.root, "current.json"), "{"), "current_invalid"],
  ["traversal", p => { p.edition = "../escape"; }, "current_path_invalid"],
  ["absolute path", p => { p.edition = "/tmp/escape"; }, "current_path_invalid"],
  ["manifest hash", p => { p.manifestSha256 = "0".repeat(64); }, "current_manifest_mismatch"],
  ["missing edition", (p, env) => fs.rmSync(path.join(env.root, p.edition), { recursive: true }), "current_edition_missing"],
  ["invalid edition", (p, env) => fs.writeFileSync(path.join(env.root, p.edition, "references.json"), "{}"), "current_edition_invalid"],
]) test(`${label} current pointer fails safely without inventing known-good`, async t => {
  const { env, next } = await pair(t);
  const p = JSON.parse(pointerBytes(env)); mutate(p, env);
  if (label !== "malformed") fs.writeFileSync(path.join(env.root, "current.json"), JSON.stringify(p));
  const broken = pointerBytes(env);
  const result = await promote(env, next);
  assert.equal(result.committed, false);
  assert.equal(result.diagnostic, diagnostic);
  assert.deepEqual(pointerBytes(env), broken);
});

test("candidate/edition symlinks are rejected and existing target bytes are untouched", async t => {
  const { env, next, current } = await pair(t);
  const file = path.join(next.workDir, FILES.editionDigest), outside = path.join(env.dir, "outside.json");
  fs.copyFileSync(file, outside); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  const before = fs.readFileSync(outside);
  assert.equal((await promote(env, next)).committed, false);
  assertProtected(env, current);
  assert.deepEqual(fs.readFileSync(outside), before);
});

test("last-boundary interruption preserves old pointer, post-commit interruption does not undo publication", async t => {
  for (const after of [false, true]) {
    const { env, next, current } = await pair(t), controller = new AbortController();
    const result = await promote(env, next, { signal: controller.signal, checkpoint(name) {
      if (name === (after ? "after-pointer-rename" : "before-pointer-rename")) controller.abort();
    } });
    assert.equal(result.committed, after);
    if (after) assert.equal(readCurrentPublication(env.root).pointer.runId, next.state.runId);
    else { assertProtected(env, current); assert.equal(stateOf(next).status, "interrupted"); }
  }
});

test("retry of a superseded publication cannot roll back a newer current edition", async t => {
  const { env, old, next } = await pair(t);
  assert.equal((await promote(env, next)).committed, true);
  const current = pointerBytes(env), oldState = stateOf(old);
  const result = await promote(env, old);
  assert.equal(result.committed, false);
  assert.equal(result.diagnostic, "publication_superseded");
  assert.deepEqual(pointerBytes(env), current);
  assert.deepEqual(stateOf(old), oldState);
});

test("post-commit lock release failure reports committed truth instead of a failed publication", async t => {
  const env = setup(t);
  const result = await runProductionDaily({ ...env, moduleUrl: adapter, now: () => AT,
    promotionOptions: { checkpoint(name) {
      if (name === "after-pointer-rename") {
        // Simulate interference with owner metadata after publication committed.
        const file = path.join(env.root, "lock/owner.json"), owner = JSON.parse(fs.readFileSync(file));
        owner.token = "changed-owner-token"; fs.writeFileSync(file, JSON.stringify(owner));
      }
    } } });
  assert.equal(result.publication.committed, true);
  assert.equal(result.publication.bookkeeping, "pending");
  assert.equal(result.publication.diagnostic, "publication_lock_release_pending");
  assert.equal(readCurrentPublication(env.root).pointer.runId, result.state.runId);
  assert.equal(result.state.status, "succeeded");
  assert.ok(fs.existsSync(path.join(env.root, "lock")));
});

test("aborted repeat reconciles already-committed truth rather than marking publication failed", async t => {
  const env = setup(t), result = await candidate(env);
  assert.equal((await promote(env, result)).committed, true);
  const current = pointerBytes(env), controller = new AbortController();
  controller.abort();
  const repeat = await promote(env, result, { signal: controller.signal });
  assert.equal(repeat.committed, true);
  assert.equal(repeat.idempotent, true);
  assert.equal(stateOf(result).publication.status, "committed");
  assert.equal(stateOf(result).status, "succeeded");
  assert.deepEqual(pointerBytes(env), current);
});
