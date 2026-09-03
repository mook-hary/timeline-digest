import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createOpenAiDigestGenerator,
  extractHttpUrls,
  generatedUrlsAreGrounded,
  validateDigestGeneration,
} from "../src/ai/digest-generator.js";
import {
  DIGEST_GENERATION_SCHEMA,
  DIGEST_GENERATOR_VERSION,
  DIGEST_SCHEMA_NAME,
} from "../src/ai/digest-prompt.js";
import { extractOpenAiErrorDiagnostic } from "../src/ai/openai-error.js";
import {
  DIGEST_CONFIG_PATH,
  NEWS_EVALUATED_PATH,
  NEWS_POOL_PATH,
  NEWS_SELECTED_PATH,
} from "../src/config.js";
import { parseDigestArgs, runDigest } from "../src/digest.js";
import { computeBaseScore } from "../src/lib/evaluation-score.js";
import {
  digestCacheKey,
  saveDigestCache,
} from "../src/sources/digest-cache.js";
import {
  resolveDigestModel,
  validateDigestConfig,
} from "../src/sources/digest-config.js";
import { digestPayloadForRecord, runDigestPipeline } from "../src/sources/digest-run.js";
import { collectWriter, makeTempDir } from "./helpers.js";

const digestConfig = validateDigestConfig(
  JSON.parse(readFileSync(DIGEST_CONFIG_PATH, "utf8"))
);

const NULL_POOL_SCORES = {
  informationValue: null,
  personalRelevance: null,
  impact: null,
  attentionSignal: null,
  importance: null,
};

function scores(partial = {}) {
  return {
    importance: 4,
    informationValue: 4,
    impact: 4,
    novelty: 3,
    personalRelevance: 2,
    ...partial,
  };
}

function makeItem(overrides = {}) {
  const id = overrides.id || "web:example:1";
  const sourceOverrides = overrides.source || {};
  return {
    id,
    source: {
      type: sourceOverrides.type || "web",
      provider: sourceOverrides.provider || "bbc-world",
      url: Object.hasOwn(sourceOverrides, "url")
        ? sourceOverrides.url
        : `https://example.com/${id}`,
      originalId: sourceOverrides.originalId || id,
      author: sourceOverrides.author || { name: null, handle: null },
    },
    title: Object.hasOwn(overrides, "title") ? overrides.title : "Title",
    summary: Object.hasOwn(overrides, "summary") ? overrides.summary : "Summary of the event.",
    category: overrides.category || "一般",
    publishedAt: overrides.publishedAt || "2026-08-30T12:00:00.000Z",
    collectedAt: overrides.collectedAt || "2026-08-30T13:00:00.000Z",
    scores: overrides.poolScores || { ...NULL_POOL_SCORES },
  };
}

function makePool(items) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-30T13:10:02.107Z",
    sourceFeeds: [],
    items,
  };
}

function makeEvaluatedCluster(overrides = {}) {
  const itemIds = overrides.itemIds || ["web:example:1"];
  const nextScores = scores(overrides.scores || {});
  return {
    clusterId: overrides.clusterId || "cluster:a",
    itemIds,
    representative: {
      itemId: overrides.itemId || itemIds[0],
      title: overrides.title || "Title",
      summary: overrides.summary || "Summary of the event.",
      category: overrides.category || "一般",
      publishedAt: overrides.publishedAt || "2026-08-30T12:00:00.000Z",
      source: {
        type: "web",
        provider: overrides.provider || "bbc-world",
        url: overrides.url || `https://example.com/${itemIds[0]}`,
      },
    },
    signals: {
      itemCount: itemIds.length,
      sourceCount: itemIds.length,
      sourceDiversity: 1,
      sourceTypes: ["web"],
      providers: overrides.providers || [overrides.provider || "bbc-world"],
    },
    scores: nextScores,
    baseScore: Object.hasOwn(overrides, "baseScore")
      ? overrides.baseScore
      : computeBaseScore(nextScores),
    reason: overrides.reason || "Do not send this reason to digest.",
    status: "evaluated",
  };
}

function makeSelectedEntry(cluster, extra = {}) {
  return {
    rank: extra.rank || 1,
    clusterId: cluster.clusterId,
    lane: extra.lane || "major",
    topicGroup: extra.topicGroup || "international",
    selectionReason: extra.selectionReason || "major-news",
    representative: cluster.representative,
    scores: cluster.scores,
    baseScore: cluster.baseScore,
  };
}

function makeSelected(entries, rejected = []) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-02T11:06:21.612Z",
    selected: entries,
    rejected,
  };
}

function makeEvaluated(clusters) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-01T07:36:24.849Z",
    clusters,
  };
}

function fixtureSet() {
  const nepal = makeItem({
    id: "web:nhk:nepal",
    source: { provider: "nhk-major", url: "https://nhk.example/nepal" },
    title: "ネパール土石流 768人死亡 3000人以上不明 6歳女児を救出",
    summary: "ネパールと中国の国境地帯で発生した大規模な土石流では768人が死亡した。",
  });
  const kyiv = makeItem({
    id: "web:bbc:kyiv",
    source: { provider: "bbc-world", url: "https://bbc.example/kyiv" },
    title: "At least 37 dead after strike on Kyiv weapons depot",
    summary: "A strike on a weapons depot in Kyiv killed at least 37 people.",
  });
  const macs = makeItem({
    id: "web:verge:macs",
    source: { provider: "the-verge", url: "https://verge.example/macs" },
    title: "Two new small, powerful Macs",
    summary: "Apple announced two new small Macs.",
  });
  const extraKyiv = makeItem({
    id: "web:bbc:kyiv-video",
    source: { provider: "bbc-world", url: "https://bbc.example/kyiv-video" },
    title: "Kyiv depot video",
    summary: "Video from the Kyiv strike.",
  });
  const rejectedItem = makeItem({
    id: "web:x:keiko",
    source: { provider: "x-timeline-collector", url: "https://x.example/keiko" },
    title: "蒸し暑い中で稽古。",
    summary: "審査課題を稽古。",
  });
  const clusters = [
    makeEvaluatedCluster({
      clusterId: "cluster:nepal",
      itemIds: ["web:nhk:nepal"],
      itemId: "web:nhk:nepal",
      title: nepal.title,
      summary: nepal.summary,
      provider: "nhk-major",
      url: nepal.source.url,
      scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
    }),
    makeEvaluatedCluster({
      clusterId: "cluster:kyiv",
      itemIds: ["web:bbc:kyiv", "web:bbc:kyiv-video"],
      itemId: "web:bbc:kyiv",
      title: kyiv.title,
      summary: kyiv.summary,
      provider: "bbc-world",
      url: kyiv.source.url,
      providers: ["bbc-world"],
      scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
    }),
    makeEvaluatedCluster({
      clusterId: "cluster:macs",
      itemIds: ["web:verge:macs"],
      itemId: "web:verge:macs",
      title: macs.title,
      summary: macs.summary,
      provider: "the-verge",
      url: macs.source.url,
      scores: { importance: 3, informationValue: 4, impact: 3, novelty: 4, personalRelevance: 5 },
    }),
    makeEvaluatedCluster({
      clusterId: "cluster:keiko",
      itemIds: ["web:x:keiko"],
      itemId: "web:x:keiko",
      title: rejectedItem.title,
      summary: rejectedItem.summary,
      provider: "x-timeline-collector",
      url: rejectedItem.source.url,
      scores: { importance: 1, informationValue: 2, impact: 1, novelty: 1, personalRelevance: 4 },
    }),
  ];
  const selected = makeSelected(
    [
      makeSelectedEntry(clusters[0], { rank: 1, lane: "major", topicGroup: "disaster" }),
      makeSelectedEntry(clusters[1], { rank: 2, lane: "major", topicGroup: "international" }),
      makeSelectedEntry(clusters[2], { rank: 3, lane: "personal", topicGroup: "ai_tech" }),
    ],
    [
      {
        clusterId: "cluster:keiko",
        rejectionReason: "below-quality-floor",
        scores: clusters[3].scores,
        baseScore: clusters[3].baseScore,
      },
    ]
  );
  return {
    pool: makePool([nepal, kyiv, extraKyiv, macs, rejectedItem]),
    evaluated: makeEvaluated(clusters),
    selected,
  };
}

function countingGenerator(result = { headline: "日本語の見出しですよ", summary: "要約です。", whyItMatters: "読む価値がある。" }) {
  const state = { calls: 0, payloads: [] };
  const generator = async (payload) => {
    state.calls += 1;
    state.payloads.push(payload);
    if (typeof result === "function") return result(payload, state);
    if (result.throw) throw new Error(result.throw);
    return result;
  };
  return { generator, state };
}

async function runOn(dir, extra = {}) {
  const fixtures = extra.fixtures || fixtureSet();
  return runDigestPipeline({
    dryRun: extra.dryRun === true,
    applyAi: extra.applyAi === true,
    requestLimit: extra.requestLimit,
    digestConfig: extra.digestConfig || digestConfig,
    generator: extra.generator,
    selected: extra.selected || fixtures.selected,
    evaluated: extra.evaluated || fixtures.evaluated,
    pool: extra.pool || fixtures.pool,
    outputPath: extra.outputPath ?? path.join(dir, "news-digest.json"),
    markdownPath: extra.markdownPath ?? path.join(dir, "news-digest.md"),
    reviewPath: extra.reviewPath ?? path.join(dir, "news-digest-review.json"),
    cachePath: extra.cachePath ?? path.join(dir, "cache.json"),
    now: extra.now || (() => "2026-09-02T12:00:00.000Z"),
    rootDir: extra.rootDir || dir,
    sourceSelectionPath: extra.sourceSelectionPath,
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

describe("digest generation v2", () => {
  it("loads digest config and resolves DIGEST_MODEL then OPENAI_MODEL", () => {
    assert.equal(digestConfig.generatorVersion, "news-digest-generator-v2");
    assert.equal(digestConfig.generatorVersion, DIGEST_GENERATOR_VERSION);
    assert.equal(resolveDigestModel({ model: "gpt-5-mini" }, { DIGEST_MODEL: "gpt-x" }), "gpt-x");
    assert.equal(resolveDigestModel({ model: "gpt-5-mini" }, { OPENAI_MODEL: "gpt-y" }), "gpt-y");
    assert.equal(resolveDigestModel({ model: "gpt-5-mini" }, {}), "gpt-5-mini");
  });

  it("rejects invalid digest config", () => {
    assert.throws(
      () => validateDigestConfig({ schemaVersion: 2 }),
      /Unsupported digest config schemaVersion/
    );
  });

  it("selected 3 become digest 3 with no item loss", async () => {
    const dir = await makeTempDir();
    const result = await runOn(dir);
    assert.equal(result.document.items.length, 3);
    assert.equal(result.stats.inputSelected, 3);
    assert.equal(result.stats.fallback, 3);
    assert.equal(result.stats.apiCalls, 0);
  });

  it("keeps rank, clusterId, lane, topicGroup, scores, and baseScore", async () => {
    const dir = await makeTempDir();
    const fixtures = fixtureSet();
    const result = await runOn(dir, { fixtures });
    const original = fixtures.selected.selected;
    for (const [index, item] of result.document.items.entries()) {
      assert.equal(item.rank, original[index].rank);
      assert.equal(item.displayOrder, original[index].rank);
      assert.equal(item.clusterId, original[index].clusterId);
      assert.equal(item.lane, original[index].lane);
      assert.equal(item.topicGroup, original[index].topicGroup);
      assert.deepEqual(item.scores, original[index].scores);
      assert.equal(item.baseScore, original[index].baseScore);
    }
  });

  it("does not revive rejected clusters", async () => {
    const dir = await makeTempDir();
    const result = await runOn(dir);
    const ids = result.document.items.map((item) => item.clusterId);
    assert.equal(ids.includes("cluster:keiko"), false);
    assert.deepEqual(ids, ["cluster:nepal", "cluster:kyiv", "cluster:macs"]);
  });

  it("fallback uses original title/summary and null whyItMatters", async () => {
    const dir = await makeTempDir();
    const result = await runOn(dir);
    const nepal = result.document.items[0];
    assert.equal(nepal.status, "fallback");
    assert.equal(nepal.headline, "ネパール土石流 768人死亡 3000人以上不明 6歳女児を救出");
    assert.equal(nepal.summary, "ネパールと中国の国境地帯で発生した大規模な土石流では768人が死亡した。");
    assert.equal(nepal.whyItMatters, null);
  });

  it("accepts valid AI structured output", () => {
    const judged = validateDigestGeneration(
      {
        headline: "ネパール土石流で768人死亡",
        summary: "国境地帯の土石流で768人が死亡した。",
        whyItMatters: "被害規模が大きい。",
      },
      { groundedInput: "{}" }
    );
    assert.equal(judged.status, "ok");
  });

  it("rejects invalid structured output, generated URLs, banned why phrases, and meta expressions", () => {
    assert.equal(validateDigestGeneration({ headline: "短い" }, { groundedInput: "{}" }).status, "failed");
    assert.equal(
      validateDigestGeneration(
        {
          headline: "abcdefgh",
          summary: "要約です。",
          whyItMatters: "理由です。https://evil.example/made-up",
        },
        { groundedInput: '{"title":"no url here"}' }
      ).error,
      "ungrounded-url"
    );
    assert.equal(
      validateDigestGeneration(
        {
          headline: "ネパール土石流で768人死亡",
          summary: "国境地帯の土石流で768人が死亡した。",
          whyItMatters: "幼い女児の救助が確認された点が注目されます。",
        },
        { groundedInput: "{}" }
      ).error,
      "banned-why-phrase"
    );
    assert.equal(
      validateDigestGeneration(
        {
          headline: "キーウで攻撃、少なくとも37人死亡",
          summary: "代表記事によれば少なくとも37人が死亡した。",
          whyItMatters: "住宅地近くで調査が始まった。",
        },
        { groundedInput: "{}" }
      ).error,
      "banned-meta-phrase"
    );
    assert.equal(
      generatedUrlsAreGrounded("see https://ok.example/a", "https://ok.example/a"),
      true
    );
    assert.deepEqual(extractHttpUrls("https://a.example https://a.example"), ["https://a.example"]);
  });

  it("invalid AI output becomes fallback without dropping the item", async () => {
    const dir = await makeTempDir();
    const { generator, state } = countingGenerator({
      headline: "短",
      summary: "x",
      whyItMatters: "y",
    });
    const result = await runOn(dir, { applyAi: true, generator });
    assert.equal(state.calls, 3);
    assert.equal(result.document.items.length, 3);
    assert.equal(result.stats.failed, 3);
    assert.equal(result.document.items[0].status, "failed");
    assert.equal(result.document.items[0].headline.includes("ネパール"), true);
    assert.equal(result.document.items[0].whyItMatters, null);
  });

  it("source URLs are copied from the pool and stay a subset", async () => {
    const dir = await makeTempDir();
    const fixtures = fixtureSet();
    const result = await runOn(dir, { fixtures });
    const poolUrls = new Set(fixtures.pool.items.map((item) => item.source.url));
    for (const item of result.document.items) {
      for (const source of item.sources) {
        assert.equal(poolUrls.has(source.url), true);
      }
    }
    const kyiv = result.document.items.find((item) => item.clusterId === "cluster:kyiv");
    assert.equal(kyiv.sources.length, 2);
  });

  it("prompt omits scores, baseScore, reason, and rank", () => {
    const fixtures = fixtureSet();
    const { payload } = digestPayloadForRecord(
      {
        representativeItem: fixtures.pool.items[0],
        members: [fixtures.pool.items[0]],
        signals: { itemCount: 1, providers: ["nhk-major"] },
        topicGroup: "disaster",
        lane: "major",
      },
      digestConfig
    );
    const parsed = JSON.parse(payload.input);
    assert.equal(Object.hasOwn(parsed, "scores"), false);
    assert.equal(Object.hasOwn(parsed, "baseScore"), false);
    assert.equal(Object.hasOwn(parsed, "reason"), false);
    assert.equal(Object.hasOwn(parsed, "rank"), false);
    assert.match(payload.input, /topicGroup/);
    assert.equal(payload.text.format.name, DIGEST_SCHEMA_NAME);
    assert.equal(payload.text.format.schema.required.includes("headline"), true);
    assert.equal(DIGEST_GENERATION_SCHEMA.additionalProperties, false);
  });

  it("Markdown uses major/personal sections and hides scores", async () => {
    const dir = await makeTempDir();
    const result = await runOn(dir);
    assert.match(result.markdown, /## 主要ニュース/);
    assert.match(result.markdown, /## 関心ニュース/);
    const majorIndex = result.markdown.indexOf("## 主要ニュース");
    const personalIndex = result.markdown.indexOf("## 関心ニュース");
    const nepalIndex = result.markdown.indexOf("ネパール土石流");
    const macsIndex = result.markdown.indexOf("Two new small, powerful Macs");
    assert.ok(majorIndex < nepalIndex && nepalIndex < personalIndex);
    assert.ok(personalIndex < macsIndex);
    assert.equal(result.markdown.includes("baseScore"), false);
    assert.equal(result.markdown.includes("importance"), false);
    assert.equal(result.markdown.includes("personalRelevance"), false);
    assert.equal(result.markdown.includes("なぜ重要"), false);
    assert.match(result.markdown, /他 1 ソース/);
  });

  it("dry-run makes zero API calls and writes nothing", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "news-digest.json");
    const { generator, state } = countingGenerator();
    const result = await runOn(dir, { dryRun: true, applyAi: true, generator, outputPath });
    assert.equal(state.calls, 0);
    assert.equal(result.stats.apiCalls, 0);
    await assert.rejects(() => readFile(outputPath), { code: "ENOENT" });
    const names = await readdir(dir);
    assert.equal(names.some((name) => name.includes("news-digest")), false);
  });

  it("non-AI run makes zero API calls and writes atomically", async () => {
    const dir = await makeTempDir();
    const { generator, state } = countingGenerator();
    const result = await runOn(dir, { generator });
    assert.equal(state.calls, 0);
    assert.equal(result.stats.apiCalls, 0);
    JSON.parse(await readFile(path.join(dir, "news-digest.json"), "utf8"));
    await readFile(path.join(dir, "news-digest.md"), "utf8");
    JSON.parse(await readFile(path.join(dir, "news-digest-review.json"), "utf8"));
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("apply-ai --limit 1 makes at most one new request and keeps 3 items", async () => {
    const dir = await makeTempDir();
    const { generator, state } = countingGenerator();
    const result = await runOn(dir, { applyAi: true, requestLimit: 1, generator });
    assert.equal(state.calls, 1);
    assert.equal(result.stats.judgeCalls, 1);
    assert.equal(result.document.items.length, 3);
    assert.equal(result.stats.ok, 1);
    assert.equal(result.stats.fallback, 2);
    assert.equal(result.stats.failed, 0);
  });

  it("cache hits do not consume --limit", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    await runOn(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      generator: countingGenerator().generator,
    });
    const second = countingGenerator();
    const result = await runOn(dir, {
      applyAi: true,
      requestLimit: 1,
      cachePath,
      generator: second.generator,
    });
    assert.ok(result.stats.cacheHits >= 1);
    assert.ok(second.state.calls <= 1);
    assert.equal(result.document.items.length, 3);
  });

  it("v1 cache entries do not hit under generator v2", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    const fixtures = fixtureSet();
    const { payload, contentHash } = digestPayloadForRecord(
      {
        representativeItem: fixtures.pool.items[0],
        members: [fixtures.pool.items[0]],
        signals: { itemCount: 1, providers: ["nhk-major"] },
        topicGroup: "disaster",
        lane: "major",
        clusterId: "cluster:nepal",
      },
      digestConfig
    );
    void payload;
    const v1Key = digestCacheKey({
      clusterId: "cluster:nepal",
      contentHash,
      model: digestConfig.model,
      generatorVersion: "news-digest-generator-v1",
    });
    await saveDigestCache(cachePath, {
      schemaVersion: 1,
      entries: {
        [v1Key]: {
          clusterId: "cluster:nepal",
          contentHash,
          model: digestConfig.model,
          generatorVersion: "news-digest-generator-v1",
          headline: "旧キャッシュ見出しですよ",
          summary: "旧キャッシュ要約です。",
          whyItMatters: "旧キャッシュの理由です。",
          generatedAt: "2026-09-03T05:42:01.652Z",
          status: "ok",
        },
      },
    });
    const { generator, state } = countingGenerator();
    const result = await runOn(dir, {
      applyAi: true,
      cachePath,
      fixtures,
      generator,
    });
    assert.equal(result.stats.cacheHits, 0);
    assert.equal(result.stats.cacheMisses, 3);
    assert.ok(state.calls >= 1);
    assert.equal(
      result.document.items.find((item) => item.clusterId === "cluster:nepal")?.headline,
      "日本語の見出しですよ"
    );
  });

  it("content change causes a cache miss; rank-only change does not", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    const fixtures = fixtureSet();
    await runOn(dir, {
      applyAi: true,
      cachePath,
      fixtures,
      generator: countingGenerator().generator,
    });
    const reranked = structuredClone(fixtures);
    reranked.selected.selected[0].rank = 3;
    reranked.selected.selected[2].rank = 1;
    const rankSecond = countingGenerator();
    const rankResult = await runOn(dir, {
      applyAi: true,
      cachePath,
      fixtures: reranked,
      generator: rankSecond.generator,
    });
    assert.equal(rankSecond.state.calls, 0);
    assert.equal(rankResult.stats.cacheHits, 3);

    const changed = structuredClone(fixtures);
    changed.pool.items[0].title = `${changed.pool.items[0].title} 更新`;
    changed.evaluated.clusters[0].representative.title = changed.pool.items[0].title;
    changed.selected.selected[0].representative.title = changed.pool.items[0].title;
    const contentSecond = countingGenerator();
    const contentResult = await runOn(dir, {
      applyAi: true,
      cachePath: path.join(dir, "cache-content.json"),
      fixtures: changed,
      generator: contentSecond.generator,
    });
    await runOn(dir, {
      applyAi: true,
      cachePath,
      fixtures,
      generator: countingGenerator().generator,
    });
    const miss = countingGenerator();
    const missResult = await runOn(dir, {
      applyAi: true,
      cachePath,
      fixtures: changed,
      generator: miss.generator,
    });
    assert.ok(missResult.stats.cacheMisses >= 1);
    assert.ok(miss.state.calls >= 1);
    assert.equal(contentResult.document.items.length, 3);
  });

  it("does not mutate selected, evaluated, or pool inputs", async () => {
    const dir = await makeTempDir();
    const fixtures = fixtureSet();
    const before = JSON.stringify(fixtures);
    await runOn(dir, { applyAi: true, generator: countingGenerator().generator, fixtures });
    assert.equal(JSON.stringify(fixtures), before);
  });

  it("fails when selected input is missing", async () => {
    const dir = await makeTempDir();
    await assert.rejects(
      () =>
        runDigestPipeline({
          dryRun: true,
          digestConfig,
          selectedPath: path.join(dir, "missing-selected.json"),
          evaluatedPath: path.join(dir, "missing-evaluated.json"),
          poolPath: path.join(dir, "missing-pool.json"),
        }),
      /Selected document is missing/
    );
  });

  it("429 is retried and 400 is not", async () => {
    let calls429 = 0;
    const generator429 = createOpenAiDigestGenerator({
      apiKey: "test-key",
      model: "gpt-5-mini",
      maxRetries: 1,
      sleep: async () => {},
      client: mockClient(async () => {
        calls429 += 1;
        if (calls429 === 1) {
          throw sdkError({
            status: 429,
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
            param: null,
            message: "Rate limit",
          });
        }
        return {
          output_text: JSON.stringify({
            headline: "日本語の見出しですよ",
            summary: "要約です。",
            whyItMatters: "読む価値がある。",
          }),
        };
      }),
    });
    await generator429({ model: "gpt-5-mini" });
    assert.equal(calls429, 2);

    let calls400 = 0;
    const generator400 = createOpenAiDigestGenerator({
      apiKey: "test-key",
      model: "gpt-5-mini",
      maxRetries: 1,
      sleep: async () => {},
      client: mockClient(async () => {
        calls400 += 1;
        throw sdkError({
          status: 400,
          type: "invalid_request_error",
          code: "unsupported_parameter",
          param: "temperature",
          message: "Unsupported parameter",
        });
      }),
    });
    await assert.rejects(() => generator400({ model: "gpt-5-mini" }));
    assert.equal(calls400, 1);

    let calls5xx = 0;
    const generator5xx = createOpenAiDigestGenerator({
      apiKey: "test-key",
      model: "gpt-5-mini",
      maxRetries: 1,
      sleep: async () => {},
      client: mockClient(async () => {
        calls5xx += 1;
        if (calls5xx === 1) {
          throw sdkError({
            status: 500,
            type: "server_error",
            code: "internal_error",
            param: null,
            message: "Server error",
          });
        }
        return {
          output_text: JSON.stringify({
            headline: "日本語の見出しですよ",
            summary: "要約です。",
            whyItMatters: "読む価値がある。",
          }),
        };
      }),
    });
    await generator5xx({ model: "gpt-5-mini" });
    assert.equal(calls5xx, 2);
  });

  it("redacts secrets from diagnostics", () => {
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
  });

  it("parseDigestArgs prefers dry-run over apply-ai", () => {
    assert.deepEqual(parseDigestArgs(["--apply-ai", "--dry-run"]), {
      applyAi: false,
      dryRun: true,
      requestLimit: null,
    });
    assert.throws(() => parseDigestArgs(["--limit", "0"]));
  });

  it("CLI dry-run reports stats and does not write", async () => {
    const dir = await makeTempDir();
    const fixtures = fixtureSet();
    const stdout = collectWriter();
    const code = await runDigest({
      dryRun: true,
      digestConfig,
      selected: fixtures.selected,
      evaluated: fixtures.evaluated,
      pool: fixtures.pool,
      outputPath: path.join(dir, "news-digest.json"),
      markdownPath: path.join(dir, "news-digest.md"),
      reviewPath: path.join(dir, "news-digest-review.json"),
      cachePath: path.join(dir, "cache.json"),
      stdout,
      stderr: collectWriter(),
    });
    assert.equal(code, 0);
    assert.match(stdout.toString(), /API calls: 0/);
    await assert.rejects(() => readFile(path.join(dir, "news-digest.json")), { code: "ENOENT" });
  });

  it("real selected document dry-run partitions all selected without writing", async () => {
    const selected = JSON.parse(readFileSync(NEWS_SELECTED_PATH, "utf8"));
    const evaluated = JSON.parse(readFileSync(NEWS_EVALUATED_PATH, "utf8"));
    const pool = JSON.parse(readFileSync(NEWS_POOL_PATH, "utf8"));
    const stdout = collectWriter();
    const dir = await makeTempDir();
    const code = await runDigest({
      dryRun: true,
      digestConfig,
      selected,
      evaluated,
      pool,
      outputPath: path.join(dir, "news-digest.json"),
      markdownPath: path.join(dir, "news-digest.md"),
      reviewPath: path.join(dir, "news-digest-review.json"),
      stdout,
      stderr: collectWriter(),
    });
    assert.equal(code, 0);
    assert.equal(selected.selected.length, 11);
    assert.match(stdout.toString(), /digest items: 11/);
    assert.match(stdout.toString(), /API calls: 0/);
    await assert.rejects(() => readFile(path.join(dir, "news-digest.json")), { code: "ENOENT" });
  });
});
