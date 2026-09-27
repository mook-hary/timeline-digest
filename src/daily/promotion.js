import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acquireLock, assertOwnedLock, releaseLock } from "./lock.js";
import { FILES, EDITION_FILES, STAGE_ORDER, OUTPUT_KEYS } from "./contract.js";
import { validateEditionCandidate, hashBytes, readImmutableEdition, readCurrentPublication } from "./edition.js";
import { assessXFreshness, validateFreshnessPolicy } from "./freshness.js";
import { DailyError } from "./fetch.js";
import { beginPublishing, recordCommittedPublication, timestamp, workPath, writeState } from "./state.js";

const knownCodes = new Set(["promotion_run_ineligible", "candidate_changed", "edition_conflict", "edition_invalid", "edition_missing", "edition_not_equivalent",
  "current_invalid", "current_path_invalid", "current_edition_missing", "current_edition_invalid", "current_manifest_mismatch", "current_identity_mismatch", "current_changed",
  "promotion_interrupted", "promotion_deadline", "x_collection_unverified", "x_collection_invalid", "x_collection_stale", "x_collection_future",
  "x_export_invalid", "x_export_before_collection", "x_export_future", "x_same_run_fetch_required"]);
const diagnosticOf = error => knownCodes.has(error?.code) ? error.code : "promotion_failed";
const requireValue = (condition, code) => { if (!condition) throw new DailyError(code); };

function verifyCandidateSeal(workDir, state) {
  requireValue(isDeepStrictEqual(state.stages.map(s => s.id), STAGE_ORDER), "promotion_run_ineligible");
  const stage = state.stages.at(-1);
  requireValue(stage.status === "succeeded" && stage.diagnostics?.length === 0, "promotion_run_ineligible");
  requireValue(isDeepStrictEqual(stage.artifacts?.map(a => a.path), OUTPUT_KEYS["validate-edition"].map(key => FILES[key])), "candidate_changed");
  for (const artifact of stage.artifacts) requireValue(hashBytes(fs.readFileSync(workPath(workDir, artifact.path))) === artifact.sha256, "candidate_changed");
}

function candidateBytes(workDir) {
  return Object.fromEntries(EDITION_FILES.map(name => [name, fs.readFileSync(workPath(workDir, `edition/${name}`))]));
}

function fresh(manifest, config, at) {
  assessXFreshness(manifest.inputs.x, { now: at, policy: config.freshness.x, retrieval: manifest.inputs.x,
    runId: manifest.runId, startedAt: manifest.startedAt });
}

function sameCurrent(root, previous) {
  const current = readCurrentPublication(root);
  requireValue(previous ? current?.bytes.equals(previous.bytes) : current === null, "current_changed");
}

/** Caller holds the one Daily lock continuously. The commit-point rename is
 * synchronous in the parent process: worker cancellation cannot hide a commit.
 * checkpoint/persist are local test injection points, never CLI options.
 */
export async function promoteWithLock({ root, state, config, lease, now = () => new Date(), signal,
  checkpoint = async () => {}, persist = writeState, assertWithinDeadline = () => {} }) {
  const runId = state.runId;
  requireValue(/^\d{8}T\d{6}Z$/.test(runId), "promotion_run_ineligible");
  root = path.resolve(root);
  const workDir = workPath(root, `runs/${runId}/work`);
  const runFile = workPath(root, `runs/${runId}/run.json`);
  let temporaryEdition, temporaryPointer, committed = false, publication;
  const canProceed = () => {
    assertOwnedLock(lease, root, runId);
    if (signal?.aborted) throw new DailyError("promotion_interrupted");
    assertWithinDeadline();
  };
  const save = () => persist(runFile, state);
  const finishCommitted = async (idempotent) => {
    recordCommittedPublication(state, publication, "pending");
    try {
      await checkpoint("before-bookkeeping");
      recordCommittedPublication(state, publication);
      save();
      return { committed: true, idempotent, bookkeeping: "succeeded", pointer: publication.pointer };
    } catch {
      recordCommittedPublication(state, publication, "pending");
      return { committed: true, idempotent, bookkeeping: "pending", diagnostic: "publication_bookkeeping_pending", pointer: publication.pointer };
    }
  };
  assertOwnedLock(lease, root, runId);
  try {
    const previous = readCurrentPublication(root); // Malformed/dangling is never replaced.
    if (previous?.pointer.runId === runId) {
      // No new publication, timestamp refresh, or freshness assertion. Current
      // remains truth even if the candidate/work files aged out or disappeared.
      publication = previous;
      committed = true;
      return await finishCommitted(true);
    }
    if (state.publication?.status === "committed") {
      // A later valid edition has superseded this historic publication. An
      // internal retry must not become an accidental rollback.
      return { committed: false, diagnostic: "publication_superseded", bookkeeping: "unchanged" };
    }
    canProceed();
    validateFreshnessPolicy(config);
    requireValue(["candidate", "production"].includes(state.mode) &&
      ["running", "publishing", "succeeded", "succeeded_degraded"].includes(state.status) && !state.summary.failed.length,
    "promotion_run_ineligible");
    verifyCandidateSeal(workDir, state);
    const ctx = { runId, workDir, startedAt: state.startedAt, stages: state.stages, config };
    const manifest = await validateEditionCandidate(ctx, { now: timestamp(now) });
    const bytes = candidateBytes(workDir);
    verifyCandidateSeal(workDir, state);
    requireValue(isDeepStrictEqual(JSON.parse(bytes["manifest.json"]), manifest), "candidate_changed");
    beginPublishing(state);
    save();
    await checkpoint("before-materialize");
    canProceed();
    fresh(manifest, config, timestamp(now));
    const editions = workPath(root, "editions");
    fs.mkdirSync(editions, { recursive: true });
    const finalEdition = workPath(root, `editions/${runId}`);
    const verifyExisting = () => {
      try { return readImmutableEdition(finalEdition, bytes); }
      catch { throw new DailyError("edition_conflict"); }
    };
    if (fs.existsSync(finalEdition)) verifyExisting();
    else {
      temporaryEdition = workPath(root, `editions/.${runId}.${randomUUID()}.tmp`);
      fs.mkdirSync(temporaryEdition);
      for (const name of EDITION_FILES) {
        fs.writeFileSync(workPath(temporaryEdition, name), bytes[name], { flag: "wx", mode: 0o600 });
        await checkpoint("edition-file-written", { name, directory: temporaryEdition });
      }
      readImmutableEdition(temporaryEdition, bytes); // Copied contracts/hashes, not just source.
      await checkpoint("before-edition-rename", { directory: temporaryEdition });
      canProceed();
      readImmutableEdition(temporaryEdition, bytes);
      // The Daily lock serializes all supported writers. Never rename over an
      // existing directory, including an empty or conflicting directory.
      if (fs.existsSync(finalEdition)) verifyExisting();
      else fs.renameSync(temporaryEdition, finalEdition);
      if (fs.existsSync(temporaryEdition)) fs.rmSync(temporaryEdition, { recursive: true });
      temporaryEdition = null;
    }
    await checkpoint("after-edition-rename");
    canProceed();
    verifyExisting();
    const pointer = { schemaVersion: 1, runId, editionDate: manifest.editionDate,
      promotedAt: timestamp(now), edition: `editions/${runId}`, manifestSha256: hashBytes(bytes["manifest.json"]) };
    temporaryPointer = `.${runId}.${randomUUID()}.current.tmp`;
    const temporaryFile = workPath(root, temporaryPointer);
    fs.writeFileSync(temporaryFile, `${JSON.stringify(pointer, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await checkpoint("pointer-written", { file: temporaryFile });
    requireValue(isDeepStrictEqual(readCurrentPublication(root, temporaryPointer)?.pointer, pointer), "current_invalid");
    await checkpoint("before-pointer-rename");
    // All final gates and the one commit syscall run without an async gap.
    canProceed();
    verifyCandidateSeal(workDir, state);
    verifyExisting();
    sameCurrent(root, previous);
    requireValue(isDeepStrictEqual(readCurrentPublication(root, temporaryPointer)?.pointer, pointer), "current_invalid");
    canProceed();
    fresh(manifest, config, timestamp(now));
    fs.renameSync(temporaryFile, workPath(root, "current.json")); // PUBLICATION COMMIT POINT
    committed = true;
    temporaryPointer = null;
    publication = { pointer, manifest };
    await checkpoint("after-pointer-rename");
    return await finishCommitted(false);
  } catch (error) {
    if (committed) {
      // No rollback and no failed publication status after the commit syscall.
      recordCommittedPublication(state, publication, "pending");
      return { committed: true, idempotent: false, bookkeeping: "pending", diagnostic: "publication_bookkeeping_pending", pointer: publication.pointer };
    }
    const diagnostic = diagnosticOf(error);
    // An unsuccessful repeat/verification attempt does not erase the historic
    // publication record when the pointer now needs operator investigation.
    if (state.publication?.status === "committed") return { committed: false, diagnostic, bookkeeping: "unchanged" };
    state.publication = { status: "not_committed", diagnostic };
    state.status = signal?.aborted ? "interrupted" : "failed";
    state.finishedAt = timestamp(now);
    state.summary.failed = [...new Set([...state.summary.failed, "promotion"])];
    try { save(); } catch { /* Pointer did not move; persisted publishing is recoverable. */ }
    return { committed: false, diagnostic, bookkeeping: "failed" };
  } finally {
    // Only this invocation's uniquely named temporaries. Final editions and the
    // current pointer are never removed, even after a pre-commit failure.
    if (temporaryEdition) fs.rmSync(temporaryEdition, { recursive: true, force: true });
    if (temporaryPointer) fs.rmSync(workPath(root, temporaryPointer), { force: true });
  }
}

// Internal retry/reconciliation entry point; no new CLI flag or network work.
export async function promoteRun({ root, runId, config, now = () => new Date(), ...options }) {
  requireValue(/^\d{8}T\d{6}Z$/.test(runId), "promotion_run_ineligible");
  const lease = acquireLock(root, runId, now);
  let outcome;
  try {
    const file = workPath(root, `runs/${runId}/run.json`);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    requireValue(state.runId === runId, "promotion_run_ineligible");
    const result = await promoteWithLock({ ...options, root, state, config, now, lease });
    outcome = { ...result, state };
    return outcome;
  } finally {
    try { releaseLock(lease); }
    catch (error) {
      if (!outcome?.committed) throw error;
      outcome.bookkeeping = "pending";
      outcome.diagnostic = "publication_lock_release_pending";
      outcome.state.publication.bookkeeping = "pending";
    }
  }
}
