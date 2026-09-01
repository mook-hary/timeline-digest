import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildEvaluationResponsesPayload,
  EVALUATION_JUDGMENT_SCHEMA,
  EVALUATION_SCHEMA_NAME,
  EVALUATION_SYSTEM_PROMPT,
} from "../src/ai/evaluation-prompt.js";
import {
  evaluateClusterJudgment,
  validateEvaluationJudgment,
} from "../src/ai/evaluation-judge.js";
import {
  createOpenAiEvaluator,
  extractOutputText,
} from "../src/ai/openai-client.js";
import { extractOpenAiErrorDiagnostic } from "../src/ai/openai-error.js";
import { EVALUATION_CONFIG_PATH } from "../src/config.js";
import { parseEvaluateArgs, runEvaluate } from "../src/evaluate.js";
import { computeBaseScore } from "../src/lib/evaluation-score.js";
import {
  buildEvaluatedCluster,
  sortEvaluationTargets,
} from "../src/sources/evaluation-clusters.js";
import {
  resolveEvaluationModel,
  validateEvaluationConfig,
} from "../src/sources/evaluation-config.js";
import { runEvaluationPipeline } from "../src/sources/evaluation-run.js";
import { collectWriter, makeTempDir } from "./helpers.js";

const evaluationConfig = validateEvaluationConfig(
  JSON.parse(readFileSync(EVALUATION_CONFIG_PATH, "utf8"))
);

const NULL_SCORES = {
  informationValue: null,
  personalRelevance: null,
  impact: null,
  attentionSignal: null,
  importance: null,
};

const validScores = {
  importance: 4,
  informationValue: 5,
  impact: 3,
  novelty: 4,
  personalRelevance: 2,
};

function makeItem(overrides = {}) {
  const id = overrides.id || "web:example:1";
  const sourceOverrides = overrides.source || {};
  return {
    id,
    source: {
      type: sourceOverrides.type || "web",
      provider: sourceOverrides.provider || "example",
      url: Object.hasOwn(sourceOverrides, "url") ? sourceOverrides.url : null,
      originalId: sourceOverrides.originalId || id,
      author: sourceOverrides.author || { name: null, handle: null },
    },
    title: Object.hasOwn(overrides, "title") ? overrides.title : "Title",
    summary: Object.hasOwn(overrides, "summary") ? overrides.summary : "Summary",
    category: Object.hasOwn(overrides, "category") ? overrides.category : "一般",
    publishedAt: Object.hasOwn(overrides, "publishedAt")
      ? overrides.publishedAt
      : "2026-08-30T12:00:00.000Z",
    collectedAt: Object.hasOwn(overrides, "collectedAt")
      ? overrides.collectedAt
      : "2026-08-30T13:00:00.000Z",
    scores: overrides.scores || { ...NULL_SCORES },
  };
}

function makePool(items) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-30T12:00:00.000Z",
    sourceFeeds: [],
    items,
  };
}

function makeSemantic(clusters) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-30T18:18:27.736Z",
    sourcePool: {
      path: "data/normalized/news-pool.json",
      generatedAt: "2026-08-30T13:10:02.107Z",
    },
    clusters,
  };
}

function clusterOf(id, itemIds) {
  return { id, itemIds };
}

function countingEvaluator(result = { scores: validScores, reason: "ok" }) {
  const state = { calls: 0, payloads: [] };
  const evaluator = async (payload) => {
    state.calls += 1;
    state.payloads.push(payload);
    if (result.throw) throw new Error(result.throw);
    return result;
  };
  return { evaluator, state };
}

const trioItems = [
  makeItem({
    id: "web:bbc:1",
    source: { provider: "bbc-world", url: "https://bbc.example/milo" },
    title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
    publishedAt: "2026-08-30T10:00:00.000Z",
  }),
  makeItem({
    id: "web:verge:2",
    source: { provider: "the-verge", url: "https://verge.example/milo" },
    title: "Alt-right troll Milo Yiannopoulos has been deported",
    publishedAt: "2026-08-30T11:00:00.000Z",
  }),
  makeItem({
    id: "web:nasa:3",
    source: { provider: "nasa-news", url: "https://nasa.example/artemis" },
    title: "NASA Artemis II crew receives medal",
    publishedAt: "2026-08-30T09:00:00.000Z",
  }),
  makeItem({
    id: "web:solo:4",
    source: { provider: "bbc-world", url: "https://bbc.example/solo" },
    title: "Unrelated bakery contest",
    publishedAt: "2026-08-31T10:00:00.000Z",
  }),
];

const trioClusters = [
  clusterOf("cluster:milo", ["web:bbc:1", "web:verge:2"]),
  clusterOf("cluster:nasa", ["web:nasa:3"]),
  clusterOf("cluster:solo", ["web:solo:4"]),
];

async function runEval(dir, extra = {}) {
  return runEvaluationPipeline({
    applyAi: extra.applyAi === true,
    dryRun: extra.dryRun === true,
    requestLimit: extra.requestLimit,
    evaluationConfig: extra.evaluationConfig || evaluationConfig,
    evaluator: extra.evaluator,
    semantic: extra.semantic || makeSemantic(trioClusters),
    pool: extra.pool || makePool(trioItems),
    outputPath: extra.outputPath ?? path.join(dir, "news-evaluated.json"),
    cachePath: extra.cachePath ?? path.join(dir, "cache.json"),
    now: extra.now || (() => "2026-08-31T00:00:00.000Z"),
  });
}

function mockClient(create) {
  return { responses: { create } };
}

function sdkError({
  status,
  type = "invalid_request_error",
  code = "unsupported_parameter",
  param = "temperature",
  message = "Unsupported parameter",
} = {}) {
  const error = new Error(message);
  error.status = status;
  error.type = type;
  error.code = code;
  error.param = param;
  error.error = { message, type, code, param };
  return error;
}

describe("AI cluster evaluation", () => {
  it("Case A: default evaluate makes zero AI calls", async () => {
    const dir = await makeTempDir();
    const { evaluator, state } = countingEvaluator();
    const result = await runEval(dir, { evaluator });
    assert.equal(state.calls, 0);
    assert.equal(result.stats.evaluatedCount, 0);
    assert.equal(result.clusters.every((cluster) => cluster.status === "unevaluated"), true);
  });

  it("Case B: dry-run makes zero AI calls and does not write", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "news-evaluated.json");
    const { evaluator, state } = countingEvaluator();
    const result = await runEval(dir, {
      dryRun: true,
      evaluator,
      outputPath,
    });
    assert.equal(state.calls, 0);
    assert.equal(result.dryRun, true);
    await assert.rejects(() => readFile(outputPath), { code: "ENOENT" });
  });

  it("Case C: --apply-ai --limit 1 makes at most one new request", async () => {
    const dir = await makeTempDir();
    const { evaluator, state } = countingEvaluator();
    const result = await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      evaluator,
    });
    assert.ok(state.calls <= 1);
    assert.equal(result.judgeCalls, 1);
    assert.ok(result.stats.unjudged >= 1);
  });

  it("Case D: cache hits do not consume --limit", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: countingEvaluator().evaluator,
    });
    const second = countingEvaluator();
    const result = await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: second.evaluator,
    });
    assert.ok(result.stats.cacheHits >= 1);
    assert.ok(second.state.calls <= 1);
    assert.equal(result.judgeCalls, 1);
  });

  it("Case E: invalid --limit fails before API", async () => {
    assert.throws(() => parseEvaluateArgs(["--apply-ai", "--limit", "0"]));
    assert.throws(() => parseEvaluateArgs(["--apply-ai", "--limit", "-1"]));
    assert.throws(() => parseEvaluateArgs(["--apply-ai", "--limit", "abc"]));
    const { evaluator, state } = countingEvaluator();
    const stderr = collectWriter();
    const code = await runEvaluate({
      applyAi: true,
      requestLimit: 0,
      evaluationConfig,
      evaluator,
      semantic: makeSemantic(trioClusters),
      pool: makePool(trioItems),
      stdout: collectWriter(),
      stderr,
    });
    assert.equal(code, 1);
    assert.equal(state.calls, 0);
    assert.match(stderr.toString(), /limit/i);
  });

  it("Case F/G/H: evaluation order is deterministic with multi-item first", () => {
    const itemsById = new Map(trioItems.map((item) => [item.id, item]));
    const built = trioClusters.map((cluster) =>
      buildEvaluatedCluster(cluster, itemsById, evaluationConfig.weights)
    );
    const extra = [
      buildEvaluatedCluster(
        clusterOf("cluster:kyiv", ["web:bbc:1", "web:solo:4", "web:nasa:3"]),
        itemsById,
        evaluationConfig.weights
      ),
    ];
    extra[0].signals.sourceDiversity = 3;
    extra[0].signals.itemCount = 3;
    const ordered = sortEvaluationTargets([...built, extra[0]].reverse());
    assert.equal(ordered[0].clusterId, "cluster:kyiv");
    assert.equal(ordered[1].clusterId, "cluster:milo");
    assert.deepEqual(
      sortEvaluationTargets(ordered).map((cluster) => cluster.clusterId),
      ordered.map((cluster) => cluster.clusterId)
    );
  });

  it("Case I/J: valid structured scores are accepted and baseScore is local", () => {
    const judged = validateEvaluationJudgment({
      scores: validScores,
      reason: "public deportation coverage",
    });
    assert.equal(judged.status, "ok");
    assert.equal(judged.scores.importance, 4);
    assert.equal(computeBaseScore(judged.scores, evaluationConfig.weights), 3.85);
  });

  it("Case K: score 0 is rejected", () => {
    const judged = validateEvaluationJudgment({
      scores: { ...validScores, importance: 0 },
      reason: "bad",
    });
    assert.equal(judged.status, "failed");
    assert.equal(judged.scores.importance, null);
  });

  it("Case L: score 6 is rejected", () => {
    const judged = validateEvaluationJudgment({
      scores: { ...validScores, impact: 6 },
      reason: "bad",
    });
    assert.equal(judged.status, "failed");
  });

  it("Case M: non-integer score is rejected", () => {
    const judged = validateEvaluationJudgment({
      scores: { ...validScores, novelty: 3.5 },
      reason: "bad",
    });
    assert.equal(judged.status, "failed");
  });

  it("Case N: missing axis is rejected", () => {
    const { personalRelevance, ...rest } = validScores;
    const judged = validateEvaluationJudgment({
      scores: rest,
      reason: "missing",
    });
    assert.equal(judged.status, "failed");
  });

  it("Case O: missing reason is rejected", () => {
    const judged = validateEvaluationJudgment({
      scores: validScores,
    });
    assert.equal(judged.status, "failed");
    assert.equal(judged.error, "invalid-reason");
  });

  it("Case P: failed evaluation keeps null scores and baseScore", async () => {
    const dir = await makeTempDir();
    const { evaluator } = countingEvaluator({ throw: "network down" });
    const result = await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      evaluator,
    });
    const failed = result.clusters.find((cluster) => cluster.status === "failed");
    assert.ok(failed);
    assert.equal(failed.baseScore, null);
    assert.equal(failed.scores.importance, null);
    assert.equal(failed.reason, null);
  });

  it("Case Q: unjudged keeps null scores and baseScore", async () => {
    const dir = await makeTempDir();
    const result = await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      evaluator: countingEvaluator().evaluator,
    });
    const unjudged = result.clusters.filter((cluster) => cluster.status === "unjudged");
    assert.ok(unjudged.length >= 1);
    for (const cluster of unjudged) {
      assert.equal(cluster.baseScore, null);
      assert.equal(cluster.scores.importance, null);
      assert.equal(cluster.reason, null);
    }
  });

  it("Case R: only ok evaluations are cached", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: countingEvaluator().evaluator,
    });
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    assert.ok(Object.keys(cache.entries).length >= 1);
    for (const entry of Object.values(cache.entries)) {
      assert.equal(entry.status, "ok");
    }
  });

  it("Case S: failed evaluations are not cached", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: countingEvaluator({ throw: "boom" }).evaluator,
    });
    await assert.rejects(() => readFile(cachePath), { code: "ENOENT" });
  });

  it("Case T: content change causes a cache miss", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: countingEvaluator().evaluator,
    });
    const changed = trioItems.map((item) =>
      item.id === "web:verge:2"
        ? { ...item, title: "Milo Yiannopoulos deported after a new ruling" }
        : item
    );
    const second = countingEvaluator();
    const result = await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: second.evaluator,
      pool: makePool(changed),
    });
    assert.equal(second.state.calls, 1);
    assert.equal(result.stats.cacheMisses >= 1, true);
  });

  it("Case U: model change causes a cache miss", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: countingEvaluator().evaluator,
    });
    const second = countingEvaluator();
    const result = await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: second.evaluator,
      evaluationConfig: { ...evaluationConfig, model: "other-model" },
    });
    assert.equal(second.state.calls, 1);
    assert.equal(result.stats.cacheHits, 0);
  });

  it("Case V: evaluatorVersion change causes a cache miss", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: countingEvaluator().evaluator,
    });
    const second = countingEvaluator();
    const result = await runEval(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      evaluator: second.evaluator,
      evaluationConfig: { ...evaluationConfig, evaluatorVersion: "news-evaluator-v2" },
    });
    assert.equal(second.state.calls, 1);
    assert.equal(result.stats.cacheHits, 0);
  });

  it("Case W/X/Y: Responses API request shape has json_schema and no temperature", () => {
    const payload = buildEvaluationResponsesPayload({
      model: "gpt-5-mini",
      representative: trioItems[1],
      signals: {
        itemCount: 2,
        sourceCount: 2,
        sourceDiversity: 2,
        sourceTypes: ["web"],
        providers: ["bbc-world", "the-verge"],
      },
      supportingItems: [trioItems[0]],
      clipChars: 400,
    });
    assert.equal(Object.hasOwn(payload, "temperature"), false);
    assert.equal(payload.messages, undefined);
    assert.equal(payload.response_format, undefined);
    assert.equal(payload.instructions, EVALUATION_SYSTEM_PROMPT);
    assert.equal(payload.text.format.type, "json_schema");
    assert.equal(payload.text.format.name, EVALUATION_SCHEMA_NAME);
    assert.equal(payload.text.format.strict, true);
    assert.deepEqual(payload.text.format.schema, EVALUATION_JUDGMENT_SCHEMA);
    assert.match(payload.input, /Milo/);
  });

  it("Case Z: 400 keeps safe diagnostics and is not retried", async () => {
    let calls = 0;
    const evaluator = createOpenAiEvaluator({
      apiKey: "test-key",
      model: "gpt-5-mini",
      maxRetries: 1,
      sleep: async () => {},
      client: mockClient(async () => {
        calls += 1;
        throw sdkError({
          status: 400,
          type: "invalid_request_error",
          code: "unsupported_parameter",
          param: "temperature",
          message: "Unsupported parameter: 'temperature'",
        });
      }),
    });
    const judged = await evaluateClusterJudgment({ model: "gpt-5-mini" }, evaluator);
    assert.equal(calls, 1);
    assert.equal(judged.status, "failed");
    assert.equal(judged.errorDetail.httpStatus, 400);
    assert.equal(judged.errorDetail.code, "unsupported_parameter");
    assert.equal(judged.scores.importance, null);
  });

  it("Case AA: 429 is retried", async () => {
    let calls = 0;
    const evaluator = createOpenAiEvaluator({
      apiKey: "test-key",
      model: "gpt-5-mini",
      maxRetries: 1,
      sleep: async () => {},
      client: mockClient(async () => {
        calls += 1;
        if (calls === 1) {
          throw sdkError({
            status: 429,
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
            param: null,
            message: "Rate limit",
          });
        }
        return { output_text: JSON.stringify({ scores: validScores, reason: "ok" }) };
      }),
    });
    const raw = await evaluator({ model: "gpt-5-mini" });
    assert.deepEqual(raw.scores, validScores);
    assert.equal(calls, 2);
  });

  it("Case AB: 5xx is retried", async () => {
    let calls = 0;
    const evaluator = createOpenAiEvaluator({
      apiKey: "test-key",
      model: "gpt-5-mini",
      maxRetries: 1,
      sleep: async () => {},
      client: mockClient(async () => {
        calls += 1;
        if (calls === 1) {
          throw sdkError({
            status: 500,
            type: "server_error",
            code: "internal_error",
            param: null,
            message: "Server error",
          });
        }
        return { output_text: JSON.stringify({ scores: validScores, reason: "ok" }) };
      }),
    });
    await evaluator({ model: "gpt-5-mini" });
    assert.equal(calls, 2);
  });

  it("Case AC: secrets are redacted from diagnostics", () => {
    const apiKey = "sk-testplaceholderkeyvalue";
    const bearer = `Bearer ${apiKey}`;
    const error = sdkError({
      status: 400,
      message: `Denied ${apiKey} Authorization: ${bearer}`,
    });
    const diagnostic = extractOpenAiErrorDiagnostic(error);
    const serialized = JSON.stringify(diagnostic);
    assert.equal(serialized.includes(apiKey), false);
    assert.equal(serialized.includes(bearer), false);
    assert.match(extractOutputText({ output_text: "  ok  " }), /ok/);
  });

  it("Case AD/AE: membership and representative stay unchanged", async () => {
    const dir = await makeTempDir();
    const foundation = await runEval(dir, { applyAi: false });
    const result = await runEval(dir, {
      applyAi: true,
      evaluator: countingEvaluator().evaluator,
    });
    assert.equal(result.clusters.length, foundation.clusters.length);
    for (let index = 0; index < result.clusters.length; index += 1) {
      assert.deepEqual(result.clusters[index].itemIds, foundation.clusters[index].itemIds);
      assert.equal(
        result.clusters[index].representative.itemId,
        foundation.clusters[index].representative.itemId
      );
      assert.deepEqual(result.clusters[index].signals, foundation.clusters[index].signals);
    }
  });

  it("Case AF: same input and cache rebuild deterministically except generatedAt/cacheHit", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    const first = await runEval(dir, {
      applyAi: true,
      cachePath,
      evaluator: countingEvaluator().evaluator,
      now: () => "2026-08-31T00:00:00.000Z",
    });
    const second = await runEval(dir, {
      applyAi: true,
      cachePath,
      evaluator: countingEvaluator({ scores: { ...validScores, importance: 1 }, reason: "no" }).evaluator,
      now: () => "2026-08-31T01:00:00.000Z",
    });
    const strip = (document) => {
      const copy = structuredClone(document);
      delete copy.generatedAt;
      for (const cluster of copy.clusters) {
        if (cluster.evaluation) delete cluster.evaluation.cacheHit;
      }
      delete copy.stats.cacheHits;
      delete copy.stats.cacheMisses;
      delete copy.stats.judgeCalls;
      delete copy.stats.estimatedAiRequests;
      return copy;
    };
    assert.deepEqual(strip(first.document), strip(second.document));
    assert.notEqual(first.document.generatedAt, second.document.generatedAt);
    assert.equal(second.stats.cacheHits, first.clusters.length);
  });

  it("resolves EVALUATION_MODEL then OPENAI_MODEL then config.model", () => {
    assert.equal(
      resolveEvaluationModel(evaluationConfig, { EVALUATION_MODEL: "from-eval" }),
      "from-eval"
    );
    assert.equal(
      resolveEvaluationModel(evaluationConfig, { OPENAI_MODEL: "from-openai" }),
      "from-openai"
    );
    assert.equal(resolveEvaluationModel(evaluationConfig, {}), evaluationConfig.model);
  });
});
