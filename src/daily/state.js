import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function timestamp(now = () => new Date()) {
  return new Date(now()).toISOString();
}

export function runIdAt(now) {
  return timestamp(now).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// Same-directory rename exposes either the complete old or complete new JSON.
export function writeState(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function createState(runId, startedAt, stageIds, retentionDays) {
  return {
    schemaVersion: 1, runId, mode: "foundation", startedAt, finishedAt: null,
    status: "running", retainUntil: new Date(Date.parse(startedAt) + retentionDays * 86400000).toISOString(),
    summary: { failed: [], degraded: [] },
    stages: stageIds.map(id => ({ id, status: "pending", startedAt: null, finishedAt: null, diagnostic: null })),
  };
}

const stageTransitions = {
  pending: ["running", "skipped"], running: ["succeeded", "degraded", "failed", "skipped"],
};
const runTransitions = {
  running: ["publishing", "succeeded", "succeeded_degraded", "failed", "interrupted"],
  publishing: ["succeeded", "succeeded_degraded", "failed", "interrupted"],
};
const diagnostics = new Set(["stage_failed", "worker_error", "worker_exit", "invalid_result", "stage_deadline", "run_deadline", "interrupted", "upstream_failed", "stage_degraded", "stage_skipped", "runner_failed"]);

export function transitionStage(state, id, status, at, diagnostic = null) {
  const stage = state.stages.find(item => item.id === id);
  if (state.status !== "running" || !stageTransitions[stage?.status]?.includes(status)) throw new Error("Invalid stage transition");
  if (diagnostic !== null && !diagnostics.has(diagnostic)) throw new Error("Invalid diagnostic code");
  stage.status = status;
  if (status === "running") stage.startedAt = at;
  else stage.finishedAt = at;
  stage.diagnostic = diagnostic;
  if (status === "failed") state.summary.failed.push(id);
  if (status === "degraded") state.summary.degraded.push(id);
}

export function transitionRun(state, status, at) {
  if (!runTransitions[state.status]?.includes(status)) throw new Error("Invalid run transition");
  if (["publishing", "succeeded", "succeeded_degraded"].includes(status)) {
    if (state.stages.some(s => !["succeeded", "degraded", "skipped"].includes(s.status))) throw new Error("Run has unfinished or failed stages");
    if (status === "succeeded" && state.summary.degraded.length) throw new Error("Run has degradation");
    if (status === "succeeded_degraded" && !state.summary.degraded.length) throw new Error("Run has no degradation");
  }
  state.status = status;
  if (status !== "publishing") state.finishedAt = at;
}

// For trusted adapters, reject traversal and existing symlinks in declared paths.
// This is a path contract, not an OS sandbox for arbitrary JavaScript modules.
export function workPath(workDir, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Path must be relative to run work directory");
  const root = path.resolve(workDir);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Path escapes work directory");
  let current = root;
  for (const component of ["", ...path.relative(root, resolved).split(path.sep)]) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat?.isSymbolicLink()) throw new Error("Symlink in work path");
  }
  return resolved;
}
