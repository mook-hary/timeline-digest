import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runReferencesSelect } from "../src/references-select.js";
import { validateReferencesSelectionConfig, loadReferencesSelectionConfig } from "../src/sources/references-selection-config.js";
import { buildReferencesSelection, validateReferencesCandidates, runReferencesSelectionPipeline } from "../src/sources/references-selection.js";
import { buildReferencesCandidates } from "../src/sources/references-candidates.js";
import { normalizeXFeed } from "../src/sources/x-feed.js";
import { collectWriter, loadFixture, makeTempDir } from "./helpers.js";

const NOW = "2026-09-11T00:00:00.000Z";
const CONFIG = { schemaVersion: 1, policyId: "references-select-v1", primaryMinValue: 4 };
function item(id, value, roles = []) {
  return {
    id, source: { type: "x", provider: "example", url: "https://x.com/example/status/1", originalId: id, author: { name: "Example", handle: "@example" } },
    title: null, summary: null, publishedAt: null,
    media: [
      { type: "video", url: null, previewUrl: "https://pbs.twimg.com/media/a", altText: null, width: null, height: null },
      { type: "image", url: "https://pbs.twimg.com/media/b", previewUrl: null, altText: "image", width: 20, height: 30 },
    ],
    vision: { status: "ok", observations: " Original observations. ", visibleText: "original\ntext" },
    visual: { value, roles },
  };
}
function input(items = [item("five", 5), item("four", 4, ["evidence", "reference"]), item("three", 3, ["photo", "evidence"])], threshold = 3) {
  return { schemaVersion: 1, generatedAt: NOW, sourcePool: { generatedAt: NOW, itemCount: items.length }, threshold, candidateCount: items.length, items };
}
const select = (data = input(), config = CONFIG) => buildReferencesSelection(data, config, { generatedAt: NOW });

test("valid config and Phase 1 Candidates accepted", async () => {
  assert.deepEqual(validateReferencesSelectionConfig(CONFIG), CONFIG);
  assert.deepEqual(await loadReferencesSelectionConfig(new URL("../config/references-selection.json", import.meta.url)), CONFIG);
  const feed = loadFixture("valid-10.json");
  Object.assign(feed.items[0], { media: item("a", 4).media, visual: { value: 4, roles: [] } });
  const candidates = buildReferencesCandidates(normalizeXFeed(feed));
  assert.equal(select(candidates).stats.selected, 1);
});
for (const [key, values] of Object.entries({ policyId: [null, "", "  ", 4], primaryMinValue: [null, 0, 6, 3.5, "4"], schemaVersion: [undefined, 2] })) {
  for (const value of values) test(`config rejects ${key}=${value}`, () => {
    assert.throws(() => select(input(), { ...CONFIG, [key]: value }));
  });
}
test("config rejects non-object", () => {
  for (const c of [undefined, null, [], "config"]) assert.throws(() => validateReferencesSelectionConfig(c));
});
const invalidInputs = [
  ["unsupported schema", (d) => { d.schemaVersion = 2; }],
  ["duplicate IDs", (d) => { d.items[1].id = d.items[0].id; }],
  ["count mismatch", (d) => { d.candidateCount++; }],
  ["source pool missing", (d) => { delete d.sourcePool; }],
  ["source count mismatch", (d) => { d.sourcePool.itemCount = 0; }],
  ["threshold invalid", (d) => { d.threshold = "3"; }],
  ["timestamp missing", (d) => { delete d.generatedAt; }],
  ["null item", (d) => { d.items[0] = null; }],
  ["id missing", (d) => { delete d.items[0].id; }],
  ["source missing", (d) => { delete d.items[0].source; }],
  ["author malformed", (d) => { d.items[0].source.author = []; }],
  ["title missing", (d) => { delete d.items[0].title; }],
  ["visual missing", (d) => { delete d.items[0].visual; }],
  ["value null", (d) => { d.items[0].visual.value = null; }],
  ["value out of range", (d) => { d.items[0].visual.value = 6; }],
  ["roles invalid", (d) => { d.items[0].visual.roles = ["bogus"]; }],
  ["roles duplicate", (d) => { d.items[0].visual.roles = ["photo", "photo"]; }],
  ["vision invalid", (d) => { d.items[0].vision.status = "failed"; }],
  ["vision text missing", (d) => { delete d.items[0].vision.visibleText; }],
  ["media empty", (d) => { d.items[0].media = []; }],
  ["media type invalid", (d) => { d.items[0].media[0].type = "bad"; }],
  ["unsafe media", (d) => { d.items[0].media[0].previewUrl = "javascript:alert(1)"; }],
  ["media dimensions invalid", (d) => { d.items[0].media[0].height = -1; }],
];
for (const [name, change] of invalidInputs) test(`input rejects ${name}`, () => {
  const d = input(); change(d); assert.throws(() => validateReferencesCandidates(d), /references candidates/);
});
for (const [threshold, primary, valid] of [[3, 4, true], [3, 3, true], [4, 3, false], [5, 4, false]]) {
  test(`threshold ${threshold}, primary ${primary}`, () => {
    const d = input([item("a", threshold)], threshold);
    if (valid) assert.equal(select(d, { ...CONFIG, primaryMinValue: primary }).items.length, 1);
    else assert.throws(() => select(d, { ...CONFIG, primaryMinValue: primary }), /Regenerate Candidates/);
  });
}
test("selected/secondary partition, reasons, overlapping Evidence and identity", () => {
  const d = select();
  assert.deepEqual(d.stats, { inputCandidates: 3, selected: 2, secondary: 1, evidence: 2 });
  assert.deepEqual(d.items.map((i) => i.selection), [
    { status: "selected", reason: "meets-primary-threshold" },
    { status: "selected", reason: "meets-primary-threshold" },
    { status: "secondary", reason: "below-primary-threshold" },
  ]);
  assert.equal(d.stats.selected + d.stats.secondary, d.stats.inputCandidates);
  assert.equal(new Set(d.items.map((i) => i.id)).size, 3);
  assert.equal(select(input(), { ...CONFIG, primaryMinValue: 3 }).stats.selected, 3);
  assert.equal(select(input([item("a", 4)])).stats.evidence, 0);
});
test("empty Candidates valid", () => {
  assert.deepEqual(select(input([])).stats, { inputCandidates: 0, selected: 0, secondary: 0, evidence: 0 });
});
test("preserves exact input order, roles, media and Vision; never sorts by status", () => {
  const d = input([item("z", 3, ["photo", "reference"]), item("b", 5), item("a", 4)]);
  const snapshot = structuredClone(d);
  const result = select(d);
  assert.deepEqual(result.items.map(({ selection, ...publicItem }) => publicItem), d.items);
  assert.equal(result.items[0].selection.status, "secondary");
  assert.deepEqual(result, select(d));
  assert.deepEqual(d, snapshot);
  result.items[0].media[0].type = "unknown";
  result.items[0].visual.roles.push("other");
  result.items[0].source.author.name = "changed";
  assert.deepEqual(d, snapshot, "output shares no mutable public objects with input");
});
test("source-agnostic contract; Vision absent as null is valid", () => {
  const d = input([item("web:a", 4)]);
  d.items[0].source.type = "web";
  d.items[0].media[0].previewUrl = "https://example.org/image.jpg";
  d.items[0].vision = null;
  assert.equal(select(d).stats.selected, 1);
});
test("explicit public projection strips arbitrary keys at every level and ignores news scores", () => {
  const baseline = input(); const d = structuredClone(baseline);
  d.secret = "PRIVATE";
  for (const i of d.items) {
    i.rawText = "PRIVATE"; i.scores = { importance: 99 }; i.clusterId = "PRIVATE";
    i.selection = { status: "evidence" }; i.source.secret = "PRIVATE"; i.source.author.token = "PRIVATE";
    i.visual.model = "PRIVATE"; i.vision.model = "PRIVATE";
    for (const m of i.media) m.internalPath = "PRIVATE";
  }
  assert.deepEqual(select(d), select(baseline));
  assert.equal(JSON.stringify(select(d)).includes("PRIVATE"), false);
});
test("CLI/file errors preserve old output; successful write is atomic and concise", async (t) => {
  const dir = await makeTempDir(); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; throw new Error("Network forbidden"); });
  const candidatesPath = path.join(dir, "candidates.json"), outputPath = path.join(dir, "references.json");
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, JSON.stringify(CONFIG));
  await fs.writeFile(outputPath, "OLD");
  const stderr = collectWriter(), stdout = collectWriter();
  const options = { candidatesPath, outputPath, configPath, stderr, stdout, now: () => NOW };
  assert.equal(await runReferencesSelect(options), 1);
  assert.match(stderr.toString(), /missing:.*Run npm run references/);
  for (const body of ["invalid", JSON.stringify({}), JSON.stringify(input([item("a", 5)], 5))]) {
    await fs.writeFile(candidatesPath, body);
    assert.equal(await runReferencesSelect(options), 1);
    assert.equal(await fs.readFile(outputPath, "utf8"), "OLD");
  }
  await fs.writeFile(candidatesPath, JSON.stringify(input()));
  await fs.writeFile(configPath, "bad");
  assert.equal(await runReferencesSelect(options), 1);
  await fs.writeFile(configPath, JSON.stringify(CONFIG));
  const rename = fs.rename.bind(fs);
  let renames = 0;
  t.mock.method(fs, "rename", async (from, to) => {
    assert.equal(await fs.readFile(to, "utf8"), "OLD");
    assert.equal(JSON.parse(await fs.readFile(from, "utf8")).items.length, 3);
    renames++; await rename(from, to);
  });
  assert.equal(await runReferencesSelect(options), 0);
  assert.equal(renames, 1);
  assert.equal(stdout.toString(), "References Selection\ninput: 3\nselected: 2\nsecondary: 1\nevidence: 2\npolicy: references-select-v1\nprimaryMinValue: 4\n");
  const saved = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.deepEqual(saved.items, select().items);
  assert.equal(saved.generatedAt, NOW);
  assert.equal((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")).length, 0);
  const before = await fs.readFile(outputPath, "utf8");
  t.mock.method(fs, "rename", async () => { throw new Error("simulated rename failure"); });
  assert.equal(await runReferencesSelect(options), 1);
  assert.equal(await fs.readFile(outputPath, "utf8"), before);
  assert.equal((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")).length, 0);
  assert.equal(calls, 0);
});
test("runtime graph has only local selection/config/atomic modules, no upstream or AI", () => {
  const allowed = new Set(["references-select.js", "config.js", "references-selection.js", "references-selection-config.js", "atomic-write.js", "errors.js"]);
  const seen = new Set();
  function visit(url) {
    if (seen.has(url.href)) return; seen.add(url.href);
    assert.ok(allowed.has(path.basename(url.pathname)), url.pathname);
    const source = readFileSync(url, "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|\bimport\s*\(/);
    for (const [, name] of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      if (name.startsWith("node:")) assert.ok(["node:path", "node:process", "node:url", "node:fs/promises"].includes(name));
      else { assert.ok(name.startsWith(".")); visit(new URL(name, url)); }
    }
  }
  visit(new URL("../src/references-select.js", import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.scripts["references:select"], "node src/references-select.js");
});
