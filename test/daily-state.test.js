import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createState, runIdAt, transitionRun, transitionStage, workPath, writeState } from "../src/daily/state.js";

const at = "2026-09-21T08:15:00.000Z";
const make = () => createState(runIdAt(() => at), at, ["ingest:x"], 30);
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("daily fixed-clock UTC identity and retention metadata", () => {
  assert.equal(runIdAt(() => at), "20260921T081500Z");
  assert.equal(runIdAt(() => "2026-09-21T17:15:00+09:00"), "20260921T081500Z");
  assert.equal(make().retainUntil, "2026-10-21T08:15:00.000Z");
  assert.equal(make().stages[0].status, "pending");
  assert.throws(() => runIdAt(() => "invalid"));
});

test("daily run and stage transitions enforce completion and terminal states", () => {
  const state = make();
  assert.throws(() => transitionRun(state, "succeeded", at));
  assert.throws(() => transitionStage(state, "ingest:x", "succeeded", at));
  transitionStage(state, "ingest:x", "running", at);
  transitionStage(state, "ingest:x", "degraded", at, "stage_degraded");
  assert.throws(() => transitionRun(state, "succeeded", at));
  transitionRun(state, "publishing", at);
  assert.equal(state.finishedAt, null);
  transitionRun(state, "succeeded_degraded", at);
  assert.equal(state.finishedAt, at);
  assert.deepEqual(state.summary.degraded, ["ingest:x"]);
  assert.throws(() => transitionRun(state, "running", at));
  assert.throws(() => transitionStage(state, "ingest:x", "running", at));
});

test("daily skipped, failed and interrupted state contracts", () => {
  for (const status of ["failed", "interrupted"]) {
    const state = make();
    transitionStage(state, "ingest:x", "skipped", at, "interrupted");
    transitionRun(state, status, at);
    assert.equal(state.status, status);
    assert.equal(state.stages[0].startedAt, null);
  }
  const state = make();
  transitionStage(state, "ingest:x", "running", at);
  assert.throws(() => transitionStage(state, "ingest:x", "failed", at, "secret token"));
  transitionStage(state, "ingest:x", "failed", at, "stage_failed");
  assert.deepEqual(state.summary.failed, ["ingest:x"]);
  assert.throws(() => transitionRun(state, "publishing", at));
});

test("daily state replacement is atomic and leaves no temporary files", t => {
  const root = temp(t), file = path.join(root, "run.json"), state = make();
  writeState(file, state);
  const fd = fs.openSync(file, "r");
  try {
    transitionStage(state, "ingest:x", "running", at);
    writeState(file, state);
    assert.equal(JSON.parse(fs.readFileSync(fd, "utf8")).stages[0].status, "pending");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).stages[0].status, "running");
  } finally { fs.closeSync(fd); }
  assert.deepEqual(fs.readdirSync(root), ["run.json"]);
  assert.throws(() => writeState(file, { value: 1n }));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).stages[0].status, "running");
  assert.deepEqual(fs.readdirSync(root), ["run.json"]);
});

test("daily work paths reject traversal, absolute paths and symlinks", t => {
  const root = temp(t);
  assert.equal(workPath(root, "normalized/x.json"), path.join(root, "normalized/x.json"));
  for (const value of ["../outside", "/tmp/out", "a/../../out", ".", ""]) assert.throws(() => workPath(root, value));
  fs.symlinkSync(os.tmpdir(), path.join(root, "escape"));
  assert.throws(() => workPath(root, "escape/out.json"));
  fs.symlinkSync(path.join(root, "missing-target"), path.join(root, "broken"));
  assert.throws(() => workPath(root, "broken"));
});
