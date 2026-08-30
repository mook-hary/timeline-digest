import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CLUSTER_CONFIG_PATH } from "../src/config.js";
import { runCluster } from "../src/cluster.js";
import { normalizeUrlForCompare } from "../src/lib/compare-url.js";
import {
  normalizeTitleForCompare,
  titleSimilarity,
} from "../src/lib/compare-title.js";
import { ValidationError } from "../src/lib/errors.js";
import { validateClusterConfig } from "../src/sources/cluster-config.js";
import {
  buildClusterId,
  clusterNewsPool,
  detectRelationships,
} from "../src/sources/news-clusters.js";
import { collectWriter, makeTempDir } from "./helpers.js";

const clusterConfig = validateClusterConfig(
  JSON.parse(readFileSync(CLUSTER_CONFIG_PATH, "utf8"))
);

const NOW = "2026-08-30T16:30:00.000Z";
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
    summary: Object.hasOwn(overrides, "summary") ? overrides.summary : null,
    category: Object.hasOwn(overrides, "category") ? overrides.category : null,
    publishedAt: Object.hasOwn(overrides, "publishedAt")
      ? overrides.publishedAt
      : null,
    collectedAt: Object.hasOwn(overrides, "collectedAt")
      ? overrides.collectedAt
      : null,
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

async function clusterPool(items, dir, extra = {}) {
  return clusterNewsPool({
    pool: makePool(items),
    clusterConfig,
    sourcePoolPath: "data/normalized/news-pool.json",
    outputPath: extra.outputPath ?? path.join(dir, "news-clusters.json"),
    reviewPath: extra.reviewPath ?? path.join(dir, "news-clusters-review.json"),
    now: () => NOW,
  });
}

describe("news clusters", () => {
  it("Case A: unrelated items become three singletons", async () => {
    const dir = await makeTempDir();
    const result = await clusterPool(
      [
        makeItem({ id: "web:a:1", title: "Alpha story about rain" }),
        makeItem({ id: "web:b:2", title: "Beta launch of a satellite" }),
        makeItem({ id: "web:c:3", title: "Gamma election result update" }),
      ],
      dir
    );

    assert.equal(result.stats.itemCount, 3);
    assert.equal(result.stats.clusterCount, 3);
    assert.equal(result.stats.singletonCount, 3);
    assert.equal(result.stats.multiItemClusterCount, 0);
    assert.equal(result.stats.relationshipCount, 0);
  });

  it("Case B: identical normalized URLs form a same-url relationship", async () => {
    const dir = await makeTempDir();
    const result = await clusterPool(
      [
        makeItem({
          id: "web:a:1",
          title: "Story one unique title here",
          source: { url: "https://example.com/article" },
        }),
        makeItem({
          id: "web:b:2",
          title: "Story two unique title here",
          source: { url: "https://example.com/article" },
        }),
      ],
      dir
    );

    assert.equal(result.stats.byRelationshipType["same-url"], 1);
    assert.equal(result.stats.multiItemClusterCount, 1);
    assert.equal(result.document.relationships[0].type, "same-url");
    assert.equal(result.document.relationships[0].confidence, 1);
  });

  it("Case C: tracking parameters still count as same-url", () => {
    assert.equal(
      normalizeUrlForCompare("https://example.com/story?utm_source=rss&utm_medium=feed"),
      normalizeUrlForCompare("https://Example.com/story/")
    );
    const relationships = detectRelationships(
      [
        makeItem({
          id: "web:a:1",
          title: "Unique title alpha for this case",
          source: { url: "https://example.com/story?utm_campaign=x" },
        }),
        makeItem({
          id: "web:b:2",
          title: "Unique title beta for this case",
          source: { url: "HTTP://example.com/story#section" },
        }),
      ],
      clusterConfig
    );
    assert.equal(relationships.length, 1);
    assert.equal(relationships[0].type, "same-url");
  });

  it("Case D: meaningful query parameters are not same-url", () => {
    const left = normalizeUrlForCompare("https://example.com/story?id=1");
    const right = normalizeUrlForCompare("https://example.com/story?id=2");
    assert.notEqual(left, right);
    const relationships = detectRelationships(
      [
        makeItem({
          id: "web:a:1",
          title: "Unique title alpha for query case",
          source: { url: "https://example.com/story?id=1" },
        }),
        makeItem({
          id: "web:b:2",
          title: "Unique title beta for query case",
          source: { url: "https://example.com/story?id=2" },
        }),
      ],
      clusterConfig
    );
    assert.equal(relationships.filter((rel) => rel.type === "same-url").length, 0);
  });

  it("Case E: exact normalized titles form a same-title relationship", async () => {
    const dir = await makeTempDir();
    const result = await clusterPool(
      [
        makeItem({
          id: "web:a:1",
          title: "Kagawa governor race incumbent wins second term",
        }),
        makeItem({
          id: "x:x-timeline-collector:9",
          title: "Kagawa governor race incumbent wins second term",
          source: { type: "x", provider: "x-timeline-collector" },
        }),
      ],
      dir
    );

    assert.equal(result.stats.byRelationshipType["same-title"], 1);
    assert.equal(result.document.relationships[0].type, "same-title");
    assert.equal(result.document.relationships[0].confidence, 0.98);
    assert.equal(result.stats.multiItemClusterCount, 1);
  });

  it("Case F: case, spacing, and punctuation still match as same-title", () => {
    assert.equal(
      normalizeTitleForCompare("Hello, World!!!"),
      normalizeTitleForCompare("  hello   world  ")
    );
    const relationships = detectRelationships(
      [
        makeItem({ id: "web:a:1", title: "Hello, World!!! News Update" }),
        makeItem({ id: "web:b:2", title: "hello world news update" }),
      ],
      clusterConfig
    );
    assert.equal(relationships[0].type, "same-title");
  });

  it("Case G: high title similarity forms a relationship", async () => {
    const dir = await makeTempDir();
    const left =
      "NASA Artemis II crew receives Congressional Space Medal of Honor";
    const right =
      "NASA Artemis II crew receives the Congressional Space Medal of Honor";
    const similarity = titleSimilarity(left, right, clusterConfig.title);
    assert.equal(similarity.comparable, true);
    assert.ok(similarity.score >= clusterConfig.title.similarityThreshold);

    const result = await clusterPool(
      [
        makeItem({ id: "web:nasa:1", title: left }),
        makeItem({ id: "web:nasa:2", title: right }),
      ],
      dir
    );
    assert.equal(result.stats.byRelationshipType["title-similarity"], 1);
    assert.equal(result.stats.multiItemClusterCount, 1);
  });

  it("Case H: similar but different events do not relate", () => {
    const similarity = titleSimilarity(
      "Trump speaks about economy",
      "Trump speaks about Ukraine",
      clusterConfig.title
    );
    assert.equal(similarity.comparable, true);
    assert.ok(similarity.score < clusterConfig.title.similarityThreshold);

    const relationships = detectRelationships(
      [
        makeItem({ id: "web:a:1", title: "Trump speaks about economy" }),
        makeItem({ id: "web:b:2", title: "Trump speaks about Ukraine" }),
      ],
      clusterConfig
    );
    assert.equal(relationships.length, 0);
  });

  it("Case I: Japanese titles are processed deterministically", () => {
    const left = "福井県で記録的な大雨、土砂災害に引き続き厳重に警戒を";
    const right = "福井県で記録的な大雨 土砂災害に引き続き厳重に警戒を";
    assert.equal(normalizeTitleForCompare(left), normalizeTitleForCompare(right));

    const first = detectRelationships(
      [
        makeItem({ id: "web:nhk:1", title: left }),
        makeItem({ id: "web:nhk:2", title: right }),
      ],
      clusterConfig
    );
    const second = detectRelationships(
      [
        makeItem({ id: "web:nhk:2", title: right }),
        makeItem({ id: "web:nhk:1", title: left }),
      ],
      clusterConfig
    );
    assert.deepEqual(first, second);
    assert.equal(first[0].type, "same-title");

    const different = detectRelationships(
      [
        makeItem({
          id: "web:nhk:3",
          title: "ネパール土石流 768人死亡 3000人以上不明 6歳女児を救出",
        }),
        makeItem({
          id: "web:nhk:4",
          title: "ネパール土石流 当時滞在の日本人研究者 出発遅れていたら",
        }),
      ],
      clusterConfig
    );
    assert.equal(different.length, 0);
  });

  it("Case J: null title and url are skipped safely", async () => {
    const dir = await makeTempDir();
    const result = await clusterPool(
      [
        makeItem({ id: "web:a:1", title: null, source: { url: null } }),
        makeItem({ id: "web:b:2", title: null, source: { url: "not a url" } }),
        makeItem({ id: "web:c:3", title: "Completely different singleton story" }),
      ],
      dir
    );
    assert.equal(result.stats.itemCount, 3);
    assert.equal(result.stats.clusterCount, 3);
    assert.equal(result.stats.relationshipCount, 0);
  });

  it("Case K: every item belongs to exactly one cluster", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Shared exact title for cluster membership",
      }),
      makeItem({
        id: "web:b:2",
        title: "Shared exact title for cluster membership",
      }),
      makeItem({ id: "web:c:3", title: "Unrelated singleton title here" }),
    ];
    const result = await clusterPool(items, dir);
    const flattened = result.document.clusters.flatMap((cluster) => cluster.itemIds);
    assert.equal(flattened.length, items.length);
    assert.equal(new Set(flattened).size, items.length);
    assert.deepEqual(
      [...flattened].sort(),
      items.map((item) => item.id).sort()
    );
  });

  it("Case L: cluster ids are deterministic", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Deterministic cluster title example",
        source: { url: "https://example.com/same" },
      }),
      makeItem({
        id: "web:b:2",
        title: "Another deterministic title example",
        source: { url: "https://example.com/same" },
      }),
    ];
    const first = await clusterPool(items, dir);
    const second = await clusterNewsPool({
      pool: makePool(items),
      clusterConfig,
      now: () => "2026-08-31T00:00:00.000Z",
    });
    assert.deepEqual(
      first.document.clusters.map((cluster) => cluster.id),
      second.document.clusters.map((cluster) => cluster.id)
    );
    assert.equal(
      first.document.clusters[0].id,
      buildClusterId(first.document.clusters[0].itemIds)
    );
  });

  it("Case M: input ordering does not change cluster ids", async () => {
    const items = [
      makeItem({
        id: "web:z:1",
        title: "Order independent title for this pair",
        source: { url: "https://example.com/order" },
      }),
      makeItem({
        id: "web:a:2",
        title: "Different title still same url pair",
        source: { url: "https://example.com/order" },
      }),
      makeItem({ id: "web:m:3", title: "Singleton leftover story title" }),
    ];
    const dir = await makeTempDir();
    const forward = await clusterPool(items, dir);
    const reversed = await clusterNewsPool({
      pool: makePool([...items].reverse()),
      clusterConfig,
    });
    assert.deepEqual(
      new Set(forward.document.clusters.map((cluster) => cluster.id)),
      new Set(reversed.document.clusters.map((cluster) => cluster.id))
    );
  });

  it("Case N: stats match the produced clusters and relationships", async () => {
    const dir = await makeTempDir();
    const result = await clusterPool(
      [
        makeItem({
          id: "web:a:1",
          title: "Stats pair one unique wording",
          source: { url: "https://example.com/stats" },
        }),
        makeItem({
          id: "web:b:2",
          title: "Stats pair two unique wording",
          source: { url: "https://example.com/stats" },
        }),
        makeItem({ id: "web:c:3", title: "Stats singleton unique wording" }),
      ],
      dir
    );
    assert.equal(result.stats.itemCount, 3);
    assert.equal(result.stats.clusterCount, 2);
    assert.equal(result.stats.multiItemClusterCount, 1);
    assert.equal(result.stats.singletonCount, 1);
    assert.equal(result.stats.relationshipCount, 1);
    assert.equal(result.stats.byRelationshipType["same-url"], 1);
    assert.equal(result.stats.byRelationshipType["same-title"], 0);
    assert.equal(result.stats.byRelationshipType["title-similarity"], 0);
  });

  it("Case O: missing news-pool fails without writing output", async () => {
    const dir = await makeTempDir();
    const stdout = collectWriter();
    const stderr = collectWriter();
    const outputPath = path.join(dir, "news-clusters.json");
    const code = await runCluster({
      poolPath: path.join(dir, "missing-pool.json"),
      outputPath,
      reviewPath: path.join(dir, "review.json"),
      clusterConfig,
      stdout,
      stderr,
    });
    assert.equal(code, 1);
    assert.match(stderr.toString(), /News pool is missing/);
    await assert.rejects(() => readFile(outputPath));
  });

  it("Case P: cluster JSON is written atomically with no tmp leftover", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "out", "news-clusters.json");
    const reviewPath = path.join(dir, "out", "news-clusters-review.json");
    await clusterNewsPool({
      pool: makePool([
        makeItem({ id: "web:a:1", title: "Atomic write singleton title" }),
      ]),
      clusterConfig,
      outputPath,
      reviewPath,
      now: () => NOW,
    });
    const parsed = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(parsed.stats.itemCount, 1);
    const leftover = (await readdir(path.dirname(outputPath))).filter((name) =>
      name.endsWith(".tmp")
    );
    assert.deepEqual(leftover, []);
  });
});
