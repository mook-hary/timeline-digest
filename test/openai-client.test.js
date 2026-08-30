import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildSemanticResponsesPayload,
  createOpenAiJudge,
  extractOutputText,
} from "../src/ai/openai-client.js";
import { extractOpenAiErrorDiagnostic } from "../src/ai/openai-error.js";
import { judgeSemanticPair, validateSemanticJudgment } from "../src/ai/semantic-judge.js";
import {
  SEMANTIC_JUDGMENT_SCHEMA,
  SEMANTIC_SYSTEM_PROMPT,
} from "../src/ai/semantic-prompt.js";
import { CLUSTER_CONFIG_PATH } from "../src/config.js";
import { validateClusterConfig } from "../src/sources/cluster-config.js";
import { validateSemanticConfig } from "../src/sources/semantic-config.js";
import { runSemanticPipeline } from "../src/sources/semantic-run.js";
import { makeTempDir } from "./helpers.js";

const clusterConfig = validateClusterConfig(
  JSON.parse(readFileSync(CLUSTER_CONFIG_PATH, "utf8"))
);
const semanticConfig = validateSemanticConfig(
  JSON.parse(readFileSync(new URL("../config/semantic.json", import.meta.url), "utf8"))
);

const NULL_SCORES = {
  informationValue: null,
  personalRelevance: null,
  impact: null,
  attentionSignal: null,
  importance: null,
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
    collectedAt: overrides.collectedAt || "2026-08-30T13:00:00.000Z",
    scores: overrides.scores || { ...NULL_SCORES },
  };
}

const itemA = makeItem({
  id: "web:bbc-world:1",
  source: { provider: "bbc-world", url: "https://www.bbc.co.uk/news/milo" },
  title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
});
const itemB = makeItem({
  id: "web:the-verge:2",
  source: { provider: "the-verge", url: "https://www.theverge.com/milo" },
  title: "Alt-right troll Milo Yiannopoulos has been deported",
});

const validJudgment = {
  relationship: "same-event",
  confidence: 0.94,
  reason: "same deportation",
};

function mockClient(create) {
  return {
    responses: { create },
  };
}

function sdkError({
  status,
  type = "invalid_request_error",
  code = "unsupported_parameter",
  param = "temperature",
  message = "Unsupported parameter",
  headers,
} = {}) {
  const error = new Error(message);
  error.status = status;
  error.type = type;
  error.code = code;
  error.param = param;
  if (headers) error.headers = headers;
  error.error = { message, type, code, param };
  return error;
}

function judgeOptions(client, extra = {}) {
  return {
    apiKey: "test-key",
    model: "gpt-5-mini",
    maxRetries: 1,
    sleep: async () => {},
    client,
    ...extra,
  };
}

describe("OpenAI Responses API client", () => {
  it("Case A/B/C: Responses API request shape, no temperature, json_schema format", async () => {
    let payload;
    const client = mockClient(async (request) => {
      payload = request;
      return { output_text: JSON.stringify(validJudgment) };
    });
    const judge = createOpenAiJudge(judgeOptions(client));
    await judge({ itemA, itemB });

    const expected = buildSemanticResponsesPayload({
      model: "gpt-5-mini",
      itemA,
      itemB,
    });
    assert.deepEqual(payload, expected);
    assert.equal(Object.hasOwn(payload, "temperature"), false);
    assert.equal(payload.messages, undefined);
    assert.equal(payload.response_format, undefined);
    assert.equal(payload.instructions, SEMANTIC_SYSTEM_PROMPT);
    assert.equal(payload.text.format.type, "json_schema");
    assert.equal(payload.text.format.name, "semantic_judgment");
    assert.equal(payload.text.format.strict, true);
    assert.deepEqual(payload.text.format.schema, SEMANTIC_JUDGMENT_SCHEMA);
  });

  it("Case D: structured response output_text is parsed", async () => {
    const judge = createOpenAiJudge(
      judgeOptions(
        mockClient(async () => ({ output_text: JSON.stringify(validJudgment) }))
      )
    );
    assert.deepEqual(await judge({ itemA, itemB }), validJudgment);

    const fromOutputArray = extractOutputText({
      output: [
        {
          content: [
            { type: "output_text", text: JSON.stringify(validJudgment) },
          ],
        },
      ],
    });
    assert.deepEqual(JSON.parse(fromOutputArray), validJudgment);
  });

  it("Case E: invalid structured output fails and does not merge", async () => {
    const dir = await makeTempDir();
    const judge = createOpenAiJudge(
      judgeOptions(
        mockClient(async () => ({
          output_text: JSON.stringify({
            relationship: "same-story",
            confidence: 0.9,
            reason: "bad enum",
          }),
        }))
      )
    );
    const raw = await judge({ itemA, itemB });
    const validated = validateSemanticJudgment(raw);
    assert.equal(validated.status, "failed");
    assert.equal(validated.error, "invalid-relationship");

    const result = await runSemanticPipeline({
      applyAi: true,
      pool: {
        schemaVersion: 1,
        generatedAt: "2026-08-30T12:00:00.000Z",
        sourceFeeds: [],
        items: [itemA, itemB],
      },
      semanticConfig,
      clusterConfig,
      judge,
      cachePath: path.join(dir, "cache.json"),
      outputPath: path.join(dir, "news-semantic.json"),
      now: () => "2026-08-30T17:00:00.000Z",
    });
    assert.equal(result.stats.failed, 1);
    assert.equal(result.stats.sameEvent, 0);
    assert.equal(result.clusters.filter((cluster) => cluster.itemIds.length > 1).length, 0);
  });

  it("Case F: 400 SDK error keeps secret-safe status/type/code/param/message", async () => {
    const judge = createOpenAiJudge(
      judgeOptions(
        mockClient(async () => {
          throw sdkError({
            status: 400,
            type: "invalid_request_error",
            code: "unsupported_parameter",
            param: "temperature",
            message: "Unsupported parameter: 'temperature'",
          });
        })
      )
    );
    const judged = await judgeSemanticPair(itemA, itemB, {}, judge);
    assert.equal(judged.status, "failed");
    assert.equal(judged.errorDetail.category, "openai-api");
    assert.equal(judged.errorDetail.httpStatus, 400);
    assert.equal(judged.errorDetail.type, "invalid_request_error");
    assert.equal(judged.errorDetail.code, "unsupported_parameter");
    assert.equal(judged.errorDetail.param, "temperature");
    assert.match(judged.errorDetail.message, /Unsupported parameter/);
    assert.match(judged.error, /HTTP 400/);
    assert.match(judged.error, /unsupported_parameter/);
  });

  it("Case G: 429 is retried", async () => {
    let calls = 0;
    const judge = createOpenAiJudge(
      judgeOptions(
        mockClient(async () => {
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
          return { output_text: JSON.stringify(validJudgment) };
        })
      )
    );
    assert.deepEqual(await judge({ itemA, itemB }), validJudgment);
    assert.equal(calls, 2);
  });

  it("Case H: 500 is retried", async () => {
    let calls = 0;
    const judge = createOpenAiJudge(
      judgeOptions(
        mockClient(async () => {
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
          return { output_text: JSON.stringify(validJudgment) };
        })
      )
    );
    assert.deepEqual(await judge({ itemA, itemB }), validJudgment);
    assert.equal(calls, 2);
  });

  it("Case I: 400 is not retried", async () => {
    let calls = 0;
    const judge = createOpenAiJudge(
      judgeOptions(
        mockClient(async () => {
          calls += 1;
          throw sdkError({ status: 400, message: "Bad request" });
        })
      )
    );
    await assert.rejects(() => judge({ itemA, itemB }), /HTTP 400/);
    assert.equal(calls, 1);
  });

  it("Case J: API key and Authorization are not stored in diagnostics", async () => {
    const apiKey = "sk-testplaceholderkeyvalue";
    const bearer = `Bearer ${apiKey}`;
    const error = sdkError({
      status: 400,
      message: `Denied ${apiKey} Authorization: ${bearer}`,
      headers: { Authorization: bearer },
    });
    error.apiKey = apiKey;
    const diagnostic = extractOpenAiErrorDiagnostic(error);
    const serialized = JSON.stringify(diagnostic);
    assert.equal(serialized.includes(apiKey), false);
    assert.equal(serialized.includes(bearer), false);
    assert.equal(Object.hasOwn(diagnostic, "headers"), false);
    assert.equal(Object.hasOwn(diagnostic, "apiKey"), false);
    assert.match(diagnostic.message, /\[redacted\]/);

    const judge = createOpenAiJudge(
      judgeOptions(
        mockClient(async () => {
          throw error;
        }),
        { apiKey }
      )
    );
    const judged = await judgeSemanticPair(itemA, itemB, {}, judge);
    const dumped = JSON.stringify(judged);
    assert.equal(dumped.includes(apiKey), false);
    assert.equal(dumped.includes(bearer), false);
    assert.equal(Object.hasOwn(judged.errorDetail, "headers"), false);
    assert.equal(Object.hasOwn(judged.errorDetail, "apiKey"), false);
  });
});
