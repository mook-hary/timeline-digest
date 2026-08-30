import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { runIngestWeb, webIngestExitCode } from "../src/ingest-web.js";
import { ValidationError } from "../src/lib/errors.js";
import { htmlToPlainText } from "../src/lib/html-text.js";
import { ingestWebFeeds, normalizeWebItem } from "../src/sources/web-feed.js";
import { parseFeedXml } from "../src/sources/web-feed-parse.js";
import { validateWebSourcesConfig } from "../src/sources/web-sources.js";
import {
  buildWebItemId,
  compactStableId,
  resolveOriginalId,
} from "../src/sources/web-stable-id.js";
import {
  collectWriter,
  loadFixtureText,
  makeTempDir,
  mockFetchByUrl,
} from "./helpers.js";

const COLLECTED_AT = "2026-08-30T15:00:00.000Z";

function source(overrides = {}) {
  return {
    id: "example-news",
    name: "Example News",
    type: "rss",
    url: "https://example.test/rss.xml",
    enabled: true,
    defaultCategory: "一般",
    ...overrides,
  };
}

function sourcesConfig(sources) {
  return { schemaVersion: 1, sources };
}

async function ingestSources(sources, routes, dir) {
  const rawDir = path.join(dir, "raw");
  const normalizedPath = path.join(dir, "web-news.json");
  const result = await ingestWebFeeds({
    sourcesConfig: sourcesConfig(sources),
    rawDir,
    normalizedPath,
    fetchImpl: mockFetchByUrl(routes),
    now: () => COLLECTED_AT,
  });
  return { result, rawDir, normalizedPath };
}

describe("web feed adapter", () => {
  it("Case A: RSS 2.0 feed normalizes successfully", async () => {
    const dir = await makeTempDir();
    const xml = loadFixtureText("web/rss-2.0.xml");
    const { result, rawDir, normalizedPath } = await ingestSources(
      [source()],
      { "https://example.test/rss.xml": { body: xml } },
      dir
    );

    assert.equal(result.success, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.itemCount, 2);
    assert.equal(result.document.items[0].title, "First article");
    assert.equal(result.document.items[0].source.type, "web");
    assert.equal(result.document.items[0].source.provider, "example-news");
    assert.equal(
      await readFile(path.join(rawDir, "example-news.xml"), "utf8"),
      xml.endsWith("\n") ? xml : `${xml}\n`
    );
    const saved = JSON.parse(await readFile(normalizedPath, "utf8"));
    assert.equal(saved.items.length, 2);
  });

  it("Case B: Atom feed normalizes successfully", () => {
    const parsed = parseFeedXml(loadFixtureText("web/atom.xml"));
    assert.equal(parsed.format, "atom");
    assert.equal(parsed.items.length, 2);
    const first = normalizeWebItem(parsed.items[0], source({ type: "atom" }), COLLECTED_AT);
    assert.equal(first.title, "Atom one");
    assert.equal(first.source.url, "https://example.com/atom-1");
    assert.equal(first.category, "Tech");
    assert.equal(first.source.author.name, "Jane Doe");
    const second = normalizeWebItem(parsed.items[1], source({ type: "atom" }), COLLECTED_AT);
    assert.equal(second.summary, "Fuller content");
  });

  it("Case C: HTML description becomes plain text summary", () => {
    const parsed = parseFeedXml(loadFixtureText("web/rss-2.0.xml"));
    const item = normalizeWebItem(parsed.items[0], source(), COLLECTED_AT);
    assert.equal(item.summary, "Hello world & friends");
    assert.equal(htmlToPlainText("<p>Hello <b>world</b></p>"), "Hello world");
  });

  it("Case D: GUID becomes a deterministic stable id", () => {
    const parsed = parseFeedXml(loadFixtureText("web/rss-2.0.xml"));
    const item = normalizeWebItem(parsed.items[0], source(), COLLECTED_AT);
    assert.equal(resolveOriginalId(parsed.items[0]), "urn:example:a1");
    assert.equal(item.id, "web:example-news:urn:example:a1");
    assert.equal(item.source.originalId, "urn:example:a1");
  });

  it("Case E: missing GUID uses the item URL", () => {
    const parsed = parseFeedXml(loadFixtureText("web/rss-no-guid.xml"));
    const item = normalizeWebItem(parsed.items[0], source(), COLLECTED_AT);
    assert.equal(item.source.originalId, compactStableId("https://example.com/no-guid"));
    assert.equal(item.id, buildWebItemId("example-news", "https://example.com/no-guid"));
  });

  it("Case F: refetching the same article keeps the internal id", () => {
    const xml = loadFixtureText("web/rss-2.0.xml");
    const first = normalizeWebItem(parseFeedXml(xml).items[0], source(), COLLECTED_AT);
    const second = normalizeWebItem(
      parseFeedXml(xml).items[0],
      source(),
      "2026-08-31T15:00:00.000Z"
    );
    assert.equal(first.id, second.id);
    assert.notEqual(first.collectedAt, second.collectedAt);
  });

  it("Case G: published date becomes ISO 8601", () => {
    const parsed = parseFeedXml(loadFixtureText("web/rss-2.0.xml"));
    const item = normalizeWebItem(parsed.items[0], source(), COLLECTED_AT);
    assert.equal(item.publishedAt, "2024-01-01T10:00:00.000Z");
  });

  it("Case H: invalid published date becomes null", () => {
    const parsed = parseFeedXml(loadFixtureText("web/rss-invalid-date.xml"));
    const item = normalizeWebItem(parsed.items[0], source(), COLLECTED_AT);
    assert.equal(item.publishedAt, null);
  });

  it("Case I: web scores are all null", () => {
    const parsed = parseFeedXml(loadFixtureText("web/rss-2.0.xml"));
    const item = normalizeWebItem(parsed.items[0], source(), COLLECTED_AT);
    assert.deepEqual(item.scores, {
      informationValue: null,
      personalRelevance: null,
      impact: null,
      attentionSignal: null,
      importance: null,
    });
  });

  it("Case J: duplicate source config id fails", () => {
    assert.throws(
      () =>
        validateWebSourcesConfig(
          sourcesConfig([
            source({ id: "dup" }),
            source({ id: "dup", url: "https://example.test/other.xml" }),
          ])
        ),
      ValidationError
    );
    assert.throws(
      () =>
        validateWebSourcesConfig(
          sourcesConfig([
            source({ id: "dup" }),
            source({ id: "dup", url: "https://example.test/other.xml" }),
          ])
        ),
      /Duplicate source id "dup"/
    );
  });

  it("Case K: one source failure still keeps the successful source", async () => {
    const dir = await makeTempDir();
    const stdout = collectWriter();
    const stderr = collectWriter();
    const xml = loadFixtureText("web/rss-2.0.xml");

    const code = await runIngestWeb({
      sourcesConfig: sourcesConfig([
        source({ id: "ok-news", name: "OK News", url: "https://example.test/ok.xml" }),
        source({
          id: "down-news",
          name: "Down News",
          url: "https://example.test/down.xml",
        }),
      ]),
      rawDir: path.join(dir, "raw"),
      normalizedPath: path.join(dir, "web-news.json"),
      fetchImpl: mockFetchByUrl({
        "https://example.test/ok.xml": { body: xml },
        "https://example.test/down.xml": { status: 503, body: "nope" },
      }),
      now: () => COLLECTED_AT,
      stdout,
      stderr,
    });

    assert.equal(code, 2);
    assert.match(stdout.toString(), /success: 1/);
    assert.match(stdout.toString(), /failed: 1/);
    assert.match(stdout.toString(), /OK News: 2/);
    assert.match(stderr.toString(), /Down News: HTTP 503/);

    const saved = JSON.parse(await readFile(path.join(dir, "web-news.json"), "utf8"));
    assert.equal(saved.items.length, 2);
    assert.equal(saved.sourceFeeds.length, 2);
    assert.equal(saved.sourceFeeds[0].status, "ok");
    assert.equal(saved.sourceFeeds[1].status, "error");
  });

  it("Case L: all sources failing does not write normalized output", async () => {
    const dir = await makeTempDir();
    const normalizedPath = path.join(dir, "web-news.json");
    const stdout = collectWriter();
    const stderr = collectWriter();

    const code = await runIngestWeb({
      sourcesConfig: sourcesConfig([
        source({ id: "a", name: "A", url: "https://example.test/a.xml" }),
        source({ id: "b", name: "B", url: "https://example.test/b.xml" }),
      ]),
      rawDir: path.join(dir, "raw"),
      normalizedPath,
      fetchImpl: mockFetchByUrl({
        "https://example.test/a.xml": { status: 500, body: "err" },
        "https://example.test/b.xml": { throw: "ECONNREFUSED" },
      }),
      stdout,
      stderr,
    });

    assert.equal(code, 1);
    assert.match(stdout.toString(), /success: 0/);
    assert.match(stdout.toString(), /failed: 2/);
    await assert.rejects(() => readFile(normalizedPath));
  });

  it("Case M: duplicate stable id in one provider fails that source", async () => {
    const dir = await makeTempDir();
    const xml = loadFixtureText("web/rss-duplicate-guid.xml");
    const { result, normalizedPath } = await ingestSources(
      [source({ url: "https://example.test/dup.xml" })],
      { "https://example.test/dup.xml": { body: xml } },
      dir
    );

    assert.equal(result.success, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.itemCount, 0);
    assert.match(result.sourceResults[0].error, /Duplicate stable id/);
    await assert.rejects(() => readFile(normalizedPath));
    assert.equal(webIngestExitCode(result), 1);
  });
});
