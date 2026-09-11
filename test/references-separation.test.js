import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeXFeedItem } from "../src/sources/x-feed.js";
import { clusterNewsPool } from "../src/sources/news-clusters.js";
import { runSemanticPipeline } from "../src/sources/semantic-run.js";
import { runEvaluationPipeline, clusterEvaluationPayload } from "../src/sources/evaluation-run.js";
import { runSelectPipeline } from "../src/sources/select-run.js";
import { runDigestPipeline, digestPayloadForRecord } from "../src/sources/digest-run.js";
import { joinDigestRecords } from "../src/sources/digest-inputs.js";
import { buildJudgeUserMessage } from "../src/ai/semantic-prompt.js";
import { computeBaseScore } from "../src/lib/evaluation-score.js";
import { generateReferencesCandidates } from "../src/sources/references-candidates.js";
import { buildReferencesSelection } from "../src/sources/references-selection.js";
import { loadFixture } from "./helpers.js";

const NOW = "2026-09-08T00:00:00.000Z";
const config = (name) => JSON.parse(readFileSync(new URL(`../config/${name}.json`, import.meta.url), "utf8"));
const clusterConfig = config("cluster");
const semanticConfig = config("semantic");
const evaluationConfig = config("evaluation");
const selectConfig = config("select");
const digestConfig = config("digest");

test("visual metadata is independent of every news stage and AI payload", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; throw new Error("Network forbidden"); });
  const items = loadFixture("valid-10.json").items.slice(0, 3).map(normalizeXFeedItem);
  // Legacy baseline without any additive fields.
  for (const item of items) {
    delete item.media;
    delete item.vision;
    delete item.visual;
  }
  items[1].title = items[0].title;
  const original = { schemaVersion: 1, generatedAt: NOW, sourceFeeds: [], items };
  const enriched = structuredClone(original);
  for (const [index, item] of enriched.items.entries()) {
    item.visual = { value: 5 - index, roles: ["artwork", "diagram", "reference"] };
    item.vision = { status: "ok", observations: "Unrelated news-looking words: earthquake spacecraft election", visibleText: "BREAKING" };
    item.media = [{ type: "image", url: "https://pbs.twimg.com/media/example", previewUrl: null, altText: "election", width: 10, height: 10 }];
  }

  const cluster = async (pool) => clusterNewsPool({ pool, clusterConfig, now: () => NOW });
  const [beforeCluster, afterCluster] = await Promise.all([cluster(original), cluster(enriched)]);
  assert.deepEqual(afterCluster, beforeCluster, "deterministic clusters and review unchanged");

  const semantic = async (pool) => runSemanticPipeline({ pool, clusterConfig, semanticConfig, now: () => NOW });
  assert.deepEqual(await semantic(enriched), await semantic(original), "semantic candidates and dry-run output unchanged");
  assert.equal(buildJudgeUserMessage(...enriched.items.slice(0, 2)), buildJudgeUserMessage(...original.items.slice(0, 2)), "semantic AI input unchanged");

  // Fixed local cluster membership; no semantic judge or external AI is used.
  const semanticDoc = { ...beforeCluster.document, judgments: [] };
  const evaluate = async (pool) => runEvaluationPipeline({ pool, semantic: semanticDoc, evaluationConfig, now: () => NOW });
  const beforeEval = await evaluate(original);
  const afterEval = await evaluate(enriched);
  assert.deepEqual(afterEval, beforeEval, "evaluation output, signals and scores unchanged");
  for (const c of beforeEval.clusters) {
    assert.deepEqual(
      clusterEvaluationPayload(c, new Map(enriched.items.map((i) => [i.id, i])), evaluationConfig),
      clusterEvaluationPayload(c, new Map(original.items.map((i) => [i.id, i])), evaluationConfig),
      "AI evaluation payload and content hash unchanged",
    );
  }

  // Stored evaluation fixture values ensure selection is nonempty without AI.
  const evaluated = structuredClone(beforeEval.document);
  for (const c of evaluated.clusters) {
    c.scores = { importance: 5, informationValue: 5, impact: 5, novelty: 4, personalRelevance: 4 };
    c.baseScore = computeBaseScore(c.scores);
    c.status = "evaluated";
  }
  const augmentedEvaluation = structuredClone(evaluated);
  for (const c of augmentedEvaluation.clusters) {
    Object.assign(c, { visual: enriched.items[0].visual, vision: enriched.items[0].vision });
    Object.assign(c.representative, { visual: enriched.items[0].visual, vision: enriched.items[0].vision });
  }
  const select = async (doc) => runSelectPipeline({ evaluated: doc, semantic: semanticDoc, selectConfig, now: () => NOW });
  const selected = await select(evaluated);
  const afterSelect = await select(augmentedEvaluation);
  assert.ok(selected.document.selected.length > 0, "selection regression is nonempty");
  assert.deepEqual(afterSelect.document, selected.document, "Editorial Select ignores visual roles and Vision");
  assert.deepEqual(afterSelect.review, selected.review);

  const digest = async (pool) => runDigestPipeline({ pool, selected: selected.document, evaluated, digestConfig, now: () => NOW });
  const beforeDigest = await digest(original);
  const afterDigest = await digest(enriched);
  // The return value also exposes input pool/records for diagnostics; compare
  // all generated artifacts and stats, not those unchanged input references.
  for (const key of ["document", "markdown", "review", "stats"]) {
    assert.deepEqual(afterDigest[key], beforeDigest[key], `digest ${key} unchanged`);
  }
  const payloads = (pool) => joinDigestRecords({ pool, selected: selected.document, evaluated })
    .map((r) => digestPayloadForRecord(r, digestConfig));
  assert.deepEqual(payloads(enriched), payloads(original), "digest AI payload and cache hash unchanged");

  const candidates = (await generateReferencesCandidates({ pool: enriched, now: () => NOW })).document;
  assert.equal(candidates.candidateCount, 3);
  const inputSnapshot = structuredClone(enriched);
  const candidatesSnapshot = structuredClone(candidates);
  for (const primaryMinValue of [3, 4, 5]) {
    const references = buildReferencesSelection(candidates, {
      schemaVersion: 1, policyId: "references-select-v1", primaryMinValue,
    }, { generatedAt: NOW });
    assert.equal(references.stats.selected, 6 - primaryMinValue);
    assert.equal(references.stats.selected + references.stats.secondary, 3);
  }
  assert.deepEqual(candidates, candidatesSnapshot);
  assert.deepEqual(enriched, inputSnapshot);
  assert.deepEqual(await cluster(enriched), beforeCluster, "Phase 2 policy changes do not affect Cluster");
  assert.deepEqual(await evaluate(enriched), beforeEval, "Phase 2 policy changes do not affect Evaluate");
  assert.deepEqual((await select(evaluated)).document, selected.document, "Phase 2 policy changes do not affect Editorial Select");
  const afterReferencesDigest = await digest(enriched);
  for (const key of ["document", "markdown", "review", "stats"]) {
    assert.deepEqual(afterReferencesDigest[key], beforeDigest[key], `Phase 2 leaves digest ${key} unchanged`);
  }
  assert.equal(calls, 0);
});

test("References runtime import graph contains no AI SDK, network or upstream runner", () => {
  const seen = new Set();
  function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = readFileSync(url, "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|\bimport\s*\(/);
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const name = match[1];
      if (name.startsWith("node:")) {
        assert.ok(["node:fs/promises", "node:path", "node:process", "node:url", "node:crypto"].includes(name), name);
      } else {
        assert.ok(name.startsWith("."), `unexpected external dependency: ${name}`);
        assert.doesNotMatch(name, /\/ai\/|fetch-|ingest-|semantic-run|evaluation-run|digest-run/);
        visit(new URL(name, url));
      }
    }
  }
  visit(new URL("../src/references.js", import.meta.url));
});
