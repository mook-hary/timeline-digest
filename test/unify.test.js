import assert from "node:assert/strict";
import { copyFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ValidationError } from "../src/lib/errors.js";
import {
  unifyNewsPool,
  validateNormalizedDocument,
} from "../src/sources/news-pool.js";
import { runUnify } from "../src/unify.js";
import {
  collectWriter,
  fixturePath,
  loadFixture,
  makeTempDir,
} from "./helpers.js";

const NOW = "2026-08-30T16:00:00.000Z";

function inputsConfig(entries) {
  return {
    schemaVersion: 1,
    inputs: entries.map((entry) => ({
      id: entry.id,
      path: entry.path,
      required: entry.required !== false,
    })),
  };
}

async function unifyFixtures(dir, entries) {
  return unifyNewsPool({
    inputsConfig: inputsConfig(entries),
    rootDir: dir,
    outputPath: path.join(dir, "news-pool.json"),
    now: () => NOW,
  });
}

describe("unified news pool", () => {
  it("Case A: X 3 + Web 4 become a pool of 7", async () => {
    const dir = await makeTempDir();
    const result = await unifyFixtures(dir, [
      { id: "x", path: fixturePath("unify/x-3.json") },
      { id: "web", path: fixturePath("unify/web-4.json") },
    ]);

    assert.equal(result.inputCount, 2);
    assert.equal(result.itemCount, 7);
    assert.equal(result.document.items.length, 7);
    const saved = JSON.parse(await readFile(result.outputPath, "utf8"));
    assert.equal(saved.items.length, 7);
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.generatedAt, NOW);
  });

  it("Case B: output item count equals the sum of input item counts", async () => {
    const x = loadFixture("unify/x-3.json");
    const web = loadFixture("unify/web-4.json");
    const dir = await makeTempDir();
    const result = await unifyFixtures(dir, [
      { id: "x", path: fixturePath("unify/x-3.json") },
      { id: "web", path: fixturePath("unify/web-4.json") },
    ]);

    assert.equal(result.itemCount, x.items.length + web.items.length);
    assert.equal(result.document.items.length, x.items.length + web.items.length);
  });

  it("Case C: same source.url with different ids are both kept", async () => {
    const dir = await makeTempDir();
    const result = await unifyFixtures(dir, [
      { id: "x", path: fixturePath("unify/x-3.json") },
      { id: "web", path: fixturePath("unify/web-4.json") },
    ]);

    const shared = result.document.items.filter(
      (item) => item.source.url === "https://example.com/shared"
    );
    assert.equal(shared.length, 2);
    const ids = new Set(shared.map((item) => item.id));
    assert.equal(ids.size, 2);
    assert.ok(ids.has("x:x-timeline-collector:200"));
    assert.ok(ids.has("web:nhk-major:n1"));
  });

  it("Case D: the same item.id across inputs fails fast", async () => {
    const dir = await makeTempDir();
    await assert.rejects(
      () =>
        unifyFixtures(dir, [
          { id: "x", path: fixturePath("unify/dup-id-a.json") },
          { id: "web", path: fixturePath("unify/dup-id-b.json") },
        ]),
      ValidationError
    );
    await assert.rejects(
      () =>
        unifyFixtures(dir, [
          { id: "x", path: fixturePath("unify/dup-id-a.json") },
          { id: "web", path: fixturePath("unify/dup-id-b.json") },
        ]),
      /Duplicate item\.id "shared-collision-id".*input "x".*items\[0\].*input "web".*items\[0\]/
    );
    await assert.rejects(() => readFile(path.join(dir, "news-pool.json")));
  });

  it("Case E: schemaVersion mismatch fails", () => {
    assert.throws(
      () =>
        validateNormalizedDocument(
          loadFixture("unify/schema-v2.json"),
          'input "x" (unify/schema-v2.json)'
        ),
      /unsupported schemaVersion: 2/
    );
  });

  it("Case F: items not an array fails", () => {
    assert.throws(
      () =>
        validateNormalizedDocument(
          loadFixture("unify/items-not-array.json"),
          'input "web" (unify/items-not-array.json)'
        ),
      /items must be an array/
    );
  });

  it("Case G: missing required item field fails", async () => {
    const dir = await makeTempDir();
    await assert.rejects(
      () =>
        unifyFixtures(dir, [
          { id: "x", path: fixturePath("unify/missing-title.json") },
        ]),
      /items\[0\] missing field: title/
    );
  });

  it("Case H: nullable fields remain valid", async () => {
    const dir = await makeTempDir();
    const result = await unifyFixtures(dir, [
      { id: "web", path: fixturePath("unify/null-fields.json") },
    ]);
    assert.equal(result.itemCount, 1);
    const item = result.document.items[0];
    assert.equal(item.title, null);
    assert.equal(item.summary, null);
    assert.equal(item.category, null);
    assert.equal(item.publishedAt, null);
    assert.equal(item.collectedAt, null);
    assert.equal(item.source.url, null);
    assert.deepEqual(item.source.author, { name: null, handle: null });
  });

  it("Case I: stats byType are computed from items", async () => {
    const dir = await makeTempDir();
    const result = await unifyFixtures(dir, [
      { id: "x", path: fixturePath("unify/x-3.json") },
      { id: "web", path: fixturePath("unify/web-4.json") },
    ]);
    assert.deepEqual(result.stats.byType, { web: 4, x: 3 });
    assert.equal(result.document.stats.byType.x, 3);
    assert.equal(result.document.stats.byType.web, 4);
  });

  it("Case J: stats byProvider are computed from items", async () => {
    const dir = await makeTempDir();
    const result = await unifyFixtures(dir, [
      { id: "x", path: fixturePath("unify/x-3.json") },
      { id: "web", path: fixturePath("unify/web-4.json") },
    ]);
    assert.deepEqual(result.stats.byProvider, {
      "bbc-world": 2,
      "nhk-major": 2,
      "x-timeline-collector": 3,
    });
  });

  it("Case K: ordering is deterministic", async () => {
    const dir = await makeTempDir();
    const first = await unifyFixtures(dir, [
      { id: "x", path: fixturePath("unify/x-3.json") },
      { id: "web", path: fixturePath("unify/web-4.json") },
    ]);
    const second = await unifyNewsPool({
      inputsConfig: inputsConfig([
        { id: "web", path: fixturePath("unify/web-4.json") },
        { id: "x", path: fixturePath("unify/x-3.json") },
      ]),
      now: () => NOW,
    });

    const expected = [
      "web:bbc-world:b1",
      "x:x-timeline-collector:200",
      "web:nhk-major:n1",
      "x:x-timeline-collector:100",
      "web:bbc-world:b2",
      "web:nhk-major:n2",
      "x:x-timeline-collector:300",
    ];
    assert.deepEqual(
      first.document.items.map((item) => item.id),
      expected
    );
    assert.deepEqual(
      second.document.items.map((item) => item.id),
      expected
    );
  });

  it("Case L: required missing input fails", async () => {
    const dir = await makeTempDir();
    await copyFile(fixturePath("unify/x-3.json"), path.join(dir, "x-news.json"));
    const stdout = collectWriter();
    const stderr = collectWriter();
    const code = await runUnify({
      inputsConfig: inputsConfig([
        { id: "x", path: path.join(dir, "x-news.json") },
        { id: "web", path: path.join(dir, "missing-web.json") },
      ]),
      outputPath: path.join(dir, "news-pool.json"),
      stdout,
      stderr,
    });

    assert.equal(code, 1);
    assert.match(stderr.toString(), /Required input "web" is missing/);
    await assert.rejects(() => readFile(path.join(dir, "news-pool.json")));
  });

  it("Case M: pool JSON is written atomically with no tmp leftover", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "out", "news-pool.json");
    await unifyNewsPool({
      inputsConfig: inputsConfig([
        { id: "x", path: fixturePath("unify/x-3.json") },
        { id: "web", path: fixturePath("unify/web-4.json") },
      ]),
      outputPath,
      now: () => NOW,
    });

    const parsed = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(parsed.items.length, 7);
    const leftover = (await readdir(path.dirname(outputPath))).filter((name) =>
      name.endsWith(".tmp")
    );
    assert.deepEqual(leftover, []);
  });
});
