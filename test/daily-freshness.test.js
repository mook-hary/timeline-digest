import test from "node:test";
import assert from "node:assert/strict";
import { assessXFreshness, parseTimestamp, validateFreshnessPolicy } from "../src/daily/freshness.js";
import { boundedFetch } from "../src/daily/fetch.js";
import { loadDailyConfig } from "../src/daily/run.js";

const now = "2026-09-21T15:30:00.000Z", runId = "20260921T153000Z";
const policy = loadDailyConfig().freshness.x;
const feed = () => ({ collectionCompletedAt: now, generatedAt: now });
const settings = () => ({ now, runId, startedAt: now, policy, retrieval: { runId, status: "succeeded", fetchedAt: now } });

test("X requires affirmative same-run retrieval independently of fresh timestamps", () => {
  for (const retrieval of [undefined, { runId, status: "failed", fetchedAt: now }, { runId: "old", status: "succeeded", fetchedAt: now }, { runId, status: "succeeded", fetchedAt: "2026-09-20T15:30:00Z" }]) {
    assert.throws(() => assessXFreshness(feed(), { ...settings(), retrieval }), /same_run_fetch/);
  }
});

test("X collection freshness accepts exact boundaries and timezone offsets", () => {
  for (const collectionCompletedAt of [now, "2026-09-21T15:35:00Z", "2026-09-20T03:30:00Z", "2026-09-22T00:30:00+09:00"]) {
    assert.equal(assessXFreshness({ ...feed(), collectionCompletedAt }, settings()).collectionCompletedAt, collectionCompletedAt);
  }
});

for (const [name, changes, diagnostic] of [
  ["null", { collectionCompletedAt: null }, "unverified"],
  ["missing", { collectionCompletedAt: undefined }, "unverified"],
  ["unqualified", { collectionCompletedAt: "2026-09-21T15:30:00" }, "collection_invalid"],
  ["malformed", { collectionCompletedAt: "bad" }, "collection_invalid"],
  ["calendar rollover", { collectionCompletedAt: "2026-02-30T15:30:00Z" }, "collection_invalid"],
  ["stale despite new export", { collectionCompletedAt: "2026-09-20T03:29:59Z" }, "collection_stale"],
  ["future", { collectionCompletedAt: "2026-09-21T15:35:01Z" }, "collection_future"],
  ["invalid export", { generatedAt: "yesterday" }, "export_invalid"],
  ["missing export", { generatedAt: undefined }, "export_invalid"],
  ["early export", { generatedAt: "2026-09-21T15:24:59Z" }, "export_before_collection"],
  ["future export", { generatedAt: "2026-09-21T15:35:01Z" }, "export_future"],
]) test(`X rejects ${name}`, () => {
  assert.throws(() => assessXFreshness({ ...feed(), ...changes }, settings()), new RegExp(diagnostic));
});

test("freshness policy is configurable but cannot switch to generatedAt", () => {
  const config = loadDailyConfig();
  validateFreshnessPolicy(config);
  config.freshness.x.field = "generatedAt";
  assert.throws(() => validateFreshnessPolicy(config));
  assert.throws(() => assessXFreshness({ ...feed(), collectionCompletedAt: "2026-09-21T13:30:00Z" }, { ...settings(), policy: { ...policy, maxAgeHours: 1 } }), /stale/);
  assert.throws(() => parseTimestamp("2026-09-21T25:30:00Z"));
});

test("bounded fetch aborts both header and body hangs without retry", async () => {
  for (const body of [false, true]) {
    let calls = 0, aborted = false;
    const fetchImpl = async (url, { signal }) => {
      calls++;
      const wait = () => new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("private")); }, { once: true }));
      return body ? { ok: true, text: wait } : wait();
    };
    const observations = new Map();
    const request = boundedFetch({ fetchImpl, timeoutMs: 20, observations });
    await assert.rejects(request("https://fixture.invalid"), /fetch_timeout/);
    assert.equal(calls, 1);
    assert.equal(aborted, true);
    assert.equal(observations.get("https://fixture.invalid").diagnostic, "fetch_timeout");
  }
});

test("bounded fetch distinguishes HTTP, malformed, and source failure with no sensitive messages", async () => {
  for (const [fetchImpl, code] of [
    [async () => ({ ok: false, text: async () => "", status: 500 }), "fetch_http"],
    [async () => ({}), "fetch_malformed"],
    [async () => ({ ok: true, text: async () => 123 }), "fetch_malformed"],
    [async () => { throw new Error("private credential"); }, "fetch_source"],
  ]) {
    await assert.rejects(boundedFetch({ fetchImpl, timeoutMs: 100 })("https://fixture.invalid"), error => error.message === code);
  }
});
