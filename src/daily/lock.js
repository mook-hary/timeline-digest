import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { timestamp, transitionRun, transitionStage, writeState } from "./state.js";

function ownerAt(lock) {
  return JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
}

export function acquireLock(root, runId, now) {
  const owner = { token: randomUUID(), pid: process.pid, hostname: os.hostname(), runId, acquiredAt: timestamp(now) };
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, "lock");
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Daily lock exists; use explicit --recover-lock only for a dead local owner");
    throw error;
  }
  try { fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 }); }
  catch (error) { fs.rmdirSync(lock); throw error; }
  return { lock, token: owner.token };
}

export function releaseLock({ lock, token }) {
  if (ownerAt(lock).token !== token) throw new Error("Daily lock ownership changed; refusing release");
  fs.unlinkSync(path.join(lock, "owner.json"));
  fs.rmdirSync(lock);
}

export function recoverLock(root, { now, probe = pid => process.kill(pid, 0) } = {}) {
  const lock = path.join(root, "lock");
  // Refuse live/uncertain owners before claiming recovery, so a live runner's
  // normal release never races a recovery marker.
  function requireDead(owner) {
    if (owner.hostname !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string" || !owner.token || !/^\d{8}T\d{6}Z$/.test(owner.runId)) throw new Error("Uncertain lock owner; recovery refused");
    try { probe(owner.pid); }
    catch (error) { if (error.code === "ESRCH") return; }
    throw new Error("Live or uncertain lock owner; recovery refused");
  }
  requireDead(ownerAt(lock));
  // Serializes explicit recoveries while the lock directory prevents acquisition.
  const claim = path.join(lock, "recovery");
  fs.writeFileSync(claim, "recovery", { flag: "wx", mode: 0o600 });
  try {
    const owner = ownerAt(lock);
    requireDead(owner);
    if (ownerAt(lock).token !== owner.token) throw new Error("Lock changed during recovery");
    const file = path.join(root, "runs", owner.runId, "run.json");
    if (fs.existsSync(file)) {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state.runId !== owner.runId) throw new Error("Run identity mismatch; recovery refused");
      if (["running", "publishing"].includes(state.status)) {
        const at = timestamp(now);
        for (const stage of state.stages) {
          if (stage.status === "running") transitionStage(state, stage.id, "failed", at, "interrupted");
          else if (stage.status === "pending") transitionStage(state, stage.id, "skipped", at, "interrupted");
        }
        transitionRun(state, "interrupted", at);
        writeState(file, state);
      }
    }
    fs.unlinkSync(path.join(lock, "owner.json"));
  } finally { fs.unlinkSync(claim); }
  fs.rmdirSync(lock);
}
