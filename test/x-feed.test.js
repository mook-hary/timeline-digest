import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { runIngestX } from "../src/ingest-x.js";
import { ValidationError } from "../src/lib/errors.js";
import {
  buildNormalizedId,
  ingestXFeed,
  normalizeXFeed,
  normalizeXFeedItem,
  validateXFeed,
} from "../src/sources/x-feed.js";
import {
  collectWriter,
  loadFixture,
  loadFixtureText,
  makeTempDir,
  mockFetchJson,
} from "./helpers.js";

const INGEST_NOW = "2026-08-30T15:00:00.000Z";

async function ingestFixture(name, dir) {
  const feed = loadFixture(name);
  const rawPath = path.join(dir, "raw", "x-news-feed.json");
  const normalizedPath = path.join(dir, "normalized", "x-news.json");
  const result = await ingestXFeed({
    url: `https://example.test/fixtures/${name}`,
    rawPath,
    normalizedPath,
    fetchImpl: mockFetchJson(feed),
    now: () => INGEST_NOW,
  });
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  const normalized = JSON.parse(await readFile(normalizedPath, "utf8"));
  return { result, raw, normalized, rawPath, normalizedPath };
}

describe("X feed adapter", () => {
  it("Case A: valid 10-item feed saves raw and normalized 10", async () => {
    const dir = await makeTempDir();
    const { result, raw, normalized } = await ingestFixture("valid-10.json", dir);

    assert.equal(result.fetched, 10);
    assert.equal(result.normalized, 10);
    assert.equal(raw.items.length, 10);
    assert.equal(normalized.items.length, 10);
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.source, "x-timeline-collector");
    assert.equal(normalized.schemaVersion, 1);
    assert.equal(normalized.generatedAt, INGEST_NOW);
    assert.equal(normalized.sourceFeeds.length, 1);
    assert.equal(normalized.sourceFeeds[0].provider, "x-timeline-collector");
    assert.equal(normalized.sourceFeeds[0].itemCount, 10);
    assert.equal(
      normalized.sourceFeeds[0].sourceGeneratedAt,
      "2026-08-30T12:00:00.000Z"
    );
  });

  it("Case B: schemaVersion != 1 fails", () => {
    const feed = loadFixture("schema-version-2.json");
    assert.throws(() => validateXFeed(feed), ValidationError);
    assert.throws(
      () => validateXFeed(feed),
      /Unsupported schemaVersion: 2/
    );
  });

  it("Case C: source != x-timeline-collector fails", () => {
    const feed = loadFixture("wrong-source.json");
    assert.throws(() => validateXFeed(feed), ValidationError);
    assert.throws(() => validateXFeed(feed), /Unexpected source/);
  });

  it("Case D: scope.itemCount != items.length fails", () => {
    const feed = loadFixture("item-count-mismatch.json");
    assert.throws(() => validateXFeed(feed), ValidationError);
    assert.throws(
      () => validateXFeed(feed),
      /scope.itemCount \(99\) does not match items.length \(1\)/
    );
  });

  it("Case E: null fields normalize without dropping the item", () => {
    const feed = loadFixture("null-fields.json");
    validateXFeed(feed);
    const normalized = normalizeXFeed(feed, {
      generatedAt: INGEST_NOW,
      feedUrl: "https://example.test/null-fields.json",
    });

    assert.equal(normalized.items.length, 1);
    const item = normalized.items[0];
    assert.equal(item.id, "x:x-timeline-collector:5001");
    assert.equal(item.title, null);
    assert.equal(item.summary, null);
    assert.equal(item.category, null);
    assert.equal(item.publishedAt, null);
    assert.equal(item.collectedAt, null);
    assert.equal(item.source.type, "x");
    assert.equal(item.source.url, null);
    assert.equal(item.source.originalId, "5001");
    assert.deepEqual(item.source.author, { name: null, handle: null });
    assert.deepEqual(item.scores, {
      informationValue: null,
      personalRelevance: null,
      impact: null,
      attentionSignal: null,
      importance: null,
    });
  });

  it("Case F: scores map onto the common schema", () => {
    const feed = loadFixture("scores-mapping.json");
    const item = normalizeXFeedItem(feed.items[0]);
    assert.deepEqual(item.scores, {
      informationValue: 1,
      personalRelevance: 2,
      impact: 3,
      attentionSignal: 4,
      importance: 5,
    });
  });

  it("Case G: items that share a sourceUrl are both kept", () => {
    const feed = loadFixture("duplicate-source-url.json");
    validateXFeed(feed);
    const normalized = normalizeXFeed(feed);
    assert.equal(normalized.items.length, 2);
    assert.equal(normalized.items[0].source.url, normalized.items[1].source.url);
    assert.equal(normalized.items[0].source.originalId, "7001");
    assert.equal(normalized.items[1].source.originalId, "7002");
    assert.notEqual(normalized.items[0].id, normalized.items[1].id);
  });

  it("Case H: normalized ids are deterministic", () => {
    const feed = loadFixture("valid-10.json");
    const first = normalizeXFeedItem(feed.items[0]);
    const second = normalizeXFeedItem(feed.items[0]);
    assert.equal(first.id, second.id);
    assert.equal(first.id, "x:x-timeline-collector:1001");
    assert.equal(buildNormalizedId("1001"), "x:x-timeline-collector:1001");
    assert.equal(buildNormalizedId("1001"), buildNormalizedId("1001"));
  });

  it("Case L: duplicate item.id fails validation and does not write outputs", async () => {
    const feed = loadFixture("duplicate-item-id.json");
    assert.throws(() => validateXFeed(feed), ValidationError);
    assert.throws(
      () => validateXFeed(feed),
      /Duplicate item\.id "123" at items\[0\] and items\[1\]/
    );

    const dir = await makeTempDir();
    const rawPath = path.join(dir, "x-news-feed.json");
    const normalizedPath = path.join(dir, "x-news.json");
    const stdout = collectWriter();
    const stderr = collectWriter();

    const code = await runIngestX({
      url: "https://example.test/duplicate-item-id.json",
      rawPath,
      normalizedPath,
      fetchImpl: mockFetchJson(feed),
      stdout,
      stderr,
    });

    assert.equal(code, 1);
    assert.match(stderr.toString(), /Duplicate item\.id "123"/);
    assert.equal(stdout.toString(), "");
    await assert.rejects(() => readFile(rawPath));
    await assert.rejects(() => readFile(normalizedPath));
  });
});

describe("ingest failure policy", () => {
  it("Case I: HTTP failure returns a non-zero CLI code and does not overwrite files", async () => {
    const dir = await makeTempDir();
    const rawPath = path.join(dir, "x-news-feed.json");
    const normalizedPath = path.join(dir, "x-news.json");
    const staleRaw = { stale: true, kind: "raw" };
    const staleNormalized = { stale: true, kind: "normalized" };
    await Promise.all([
      writeFile(rawPath, JSON.stringify(staleRaw), "utf8"),
      writeFile(normalizedPath, JSON.stringify(staleNormalized), "utf8"),
    ]);

    const stdout = collectWriter();
    const stderr = collectWriter();
    const code = await runIngestX({
      url: "https://example.test/news-feed.json",
      rawPath,
      normalizedPath,
      fetchImpl: mockFetchJson("server error", { status: 503 }),
      stdout,
      stderr,
    });

    assert.equal(code, 1);
    assert.match(stderr.toString(), /HTTP 503/);
    assert.equal(stdout.toString(), "");

    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    const normalized = JSON.parse(await readFile(normalizedPath, "utf8"));
    assert.deepEqual(raw, staleRaw);
    assert.deepEqual(normalized, staleNormalized);
  });

  it("Case J: invalid JSON fails without writing outputs", async () => {
    const dir = await makeTempDir();
    const rawPath = path.join(dir, "x-news-feed.json");
    const normalizedPath = path.join(dir, "x-news.json");
    const stdout = collectWriter();
    const stderr = collectWriter();

    const code = await runIngestX({
      url: "https://example.test/invalid.json",
      rawPath,
      normalizedPath,
      fetchImpl: mockFetchJson(loadFixtureText("invalid.json")),
      stdout,
      stderr,
    });

    assert.equal(code, 1);
    assert.match(stderr.toString(), /Invalid JSON/);
    await assert.rejects(() => readFile(rawPath));
    await assert.rejects(() => readFile(normalizedPath));
  });
});
