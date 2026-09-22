import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { acquireLock, releaseLock } from "./lock.js";
import { createState, runIdAt, timestamp, transitionRun, transitionStage, workPath, writeState } from "./state.js";

export function loadDailyConfig() {
  return JSON.parse(fs.readFileSync(new URL("../../config/daily.json", import.meta.url), "utf8"));
}

function positive(value) { return Number.isSafeInteger(value) && value > 0 && value <= 2147483647; }
export function validateConfig(config) {
  if (config?.schemaVersion !== 1 || !positive(config.execution?.stageDeadlineMs) || !positive(config.execution?.runDeadlineMs) || (!positive(config.retention?.historyDays) || config.retention.historyDays > 36500)) throw new Error("Invalid Daily execution/retention config");
  const overrides = config.execution.stageDeadlinesMs;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || !Object.values(overrides).every(positive)) throw new Error("Invalid stage deadlines");
  return config;
}

export function executeStage({ moduleUrl, context, deadlineMs, deadlineCode = "stage_deadline", signal }) {
  return new Promise(resolve => {
    let message, diagnostic, stopping = false;
    const worker = new Worker(new URL("./stage-worker.js", import.meta.url), {
      workerData: { moduleUrl, context }, env: {}, stdout: true, stderr: true,
    });
    // Drain without retaining arbitrary output (which may contain secrets).
    worker.stdout.resume();
    worker.stderr.resume();
    const stop = code => {
      if (stopping) return;
      stopping = true;
      diagnostic = code;
      void worker.terminate();
    };
    const timer = setTimeout(() => stop(deadlineCode), deadlineMs);
    const abort = () => stop("interrupted");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.on("message", result => {
      if (message !== undefined) stop("invalid_result");
      else message = result;
    });
    worker.on("error", () => { diagnostic ??= "worker_error"; });
    // A success message alone is insufficient: all worker activity must exit.
    worker.on("exit", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (diagnostic || code !== 0) return resolve({ status: "failed", diagnostic: diagnostic ?? "worker_exit" });
      if (!["succeeded", "degraded", "failed", "skipped"].includes(message?.status)) return resolve({ status: "failed", diagnostic: "invalid_result" });
      resolve({ status: message.status, diagnostic: { failed: "stage_failed", degraded: "stage_degraded", skipped: "stage_skipped" }[message.status] ?? null });
    });
  });
}

/** Trusted module adapters receive explicit run-local inputs/outputs, never CLI defaults.
 * No retry, publication, freshness decision or production pipeline is wired here.
 */
export async function runDaily({ root = fileURLToPath(new URL("../../data/daily", import.meta.url)), stages,
  config = loadDailyConfig(), now = () => new Date(), signal } = {}) {
  validateConfig(config);
  if (!Array.isArray(stages) || !stages.length) throw new Error("Production Daily pipeline is not wired; supply explicit foundation stages");
  const ids = stages.map(s => s.id);
  if (ids.some(id => typeof id !== "string" || !/^[a-z][a-z0-9:_-]*$/.test(id)) || new Set(ids).size !== ids.length) throw new Error("Invalid stage identities");
  for (const stage of stages) {
    if (!stage.skip && stage.moduleUrl !== null && (typeof stage.moduleUrl !== "string" || !stage.moduleUrl.startsWith("file:"))) throw new Error("Stage requires a local module URL");
  }
  root = path.resolve(root);
  const startedAt = timestamp(now);
  const runId = runIdAt(() => startedAt);
  const runDir = path.join(root, "runs", runId);
  const workDir = path.join(runDir, "work");
  const file = path.join(runDir, "run.json");
  const state = createState(runId, startedAt, ids, config.retention.historyDays);
  const lease = acquireLock(root, runId, now);
  const start = performance.now();
  let initialized = false;
  const save = () => writeState(file, state);
  try {
    fs.mkdirSync(path.join(root, "runs"), { recursive: true });
    fs.mkdirSync(runDir); // Same-second collision refuses; never overwrite a prior run.
    fs.mkdirSync(workDir);
    save();
    initialized = true;
    for (const stage of stages) {
      const remaining = config.execution.runDeadlineMs - (performance.now() - start);
      if (signal?.aborted || remaining <= 0) {
        transitionStage(state, stage.id, "running", timestamp(now));
        transitionStage(state, stage.id, "failed", timestamp(now), signal?.aborted ? "interrupted" : "run_deadline");
        save();
        break;
      }
      if (stage.skip) {
        transitionStage(state, stage.id, "skipped", timestamp(now), "stage_skipped");
        save();
        continue;
      }
      transitionStage(state, stage.id, "running", timestamp(now));
      save();
      const paths = entries => Object.fromEntries(Object.entries(entries ?? {}).map(([key, relative]) => [key, workPath(workDir, relative)]));
      const limit = Object.hasOwn(config.execution.stageDeadlinesMs, stage.id) ? config.execution.stageDeadlinesMs[stage.id] : config.execution.stageDeadlineMs;
      const result = await executeStage({ moduleUrl: stage.moduleUrl,
        context: { runId, workDir, inputs: paths(stage.inputs), outputs: paths(stage.outputs) },
        deadlineMs: Math.max(1, Math.min(limit, remaining)),
        deadlineCode: remaining <= limit ? "run_deadline" : "stage_deadline", signal });
      // An adapter may discover it has no work after starting.
      transitionStage(state, stage.id, result.status, timestamp(now), result.diagnostic);
      save();
      if (result.status === "failed") break;
    }
    const interrupted = signal?.aborted;
    const failed = state.summary.failed.length > 0 || interrupted;
    if (failed) {
      for (const stage of state.stages.filter(s => s.status === "pending")) transitionStage(state, stage.id, "skipped", timestamp(now), interrupted ? "interrupted" : "upstream_failed");
    }
    transitionRun(state, interrupted ? "interrupted" : failed ? "failed" : state.summary.degraded.length ? "succeeded_degraded" : "succeeded", timestamp(now));
    save();
    return { state, runDir, workDir };
  } catch (error) {
    if (initialized && state.status === "running") {
      for (const stage of state.stages) {
        if (stage.status === "running") transitionStage(state, stage.id, "failed", timestamp(now), "runner_failed");
        else if (stage.status === "pending") transitionStage(state, stage.id, "skipped", timestamp(now), "upstream_failed");
      }
      transitionRun(state, "failed", timestamp(now));
      save();
    }
    throw error;
  } finally { releaseLock(lease); }
}
