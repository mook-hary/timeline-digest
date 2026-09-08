import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { normalizeXFeed, normalizeXFeedItem, validateXFeed } from "../src/sources/x-feed.js";
import { normalizeVision, normalizeVisual, normalizeXMedia, VISUAL_ROLES } from "../src/sources/x-visual.js";
import { unifyNewsPool } from "../src/sources/news-pool.js";
import { buildReferencesCandidates, generateReferencesCandidates, DEFAULT_REFERENCES_THRESHOLD } from "../src/sources/references-candidates.js";
import { runReferences } from "../src/references.js";
import { collectWriter, loadFixture, makeTempDir } from "./helpers.js";

const NOW = "2026-09-08T00:00:00.000Z";
const vision = { status: "ok", observations: "A diagram.", visibleText: "A → B" };
const visual = { value: 4, roles: ["reference", "diagram"] };
const media = [
  { type: "image", url: "https://pbs.twimg.com/media/a?format=jpg&name=orig", previewUrl: null, altText: "A diagram", width: 800, height: 600 },
  { type: "video", url: null, previewUrl: "https://pbs.twimg.com/media/b", altText: null, width: null, height: null },
];
function x(overrides = {}) {
  return normalizeXFeedItem({ ...loadFixture("valid-10.json").items[0], media, vision, visual, ...overrides });
}
function pool(items) {
  return { schemaVersion: 1, generatedAt: NOW, sourceFeeds: [], items };
}
function candidates(items, options = {}) {
  return buildReferencesCandidates(pool(items), { generatedAt: NOW, ...options });
}

test("X normalization preserves approved metadata and drops internal keys", () => {
  const item = x({
    vision: { ...vision, model: "private", cache: "secret" },
    visual: { ...visual, diagnostics: "private" },
    media: media.map((m) => ({ ...m, internalPath: "private" })),
    rawText: "private",
  });
  assert.deepEqual(item.vision, vision);
  assert.deepEqual(item.visual, visual);
  assert.deepEqual(item.media, media);
  assert.equal(JSON.stringify(item).includes("private"), false);
  const { media: m, vision: v, visual: vv, ...news } = item;
  const { media: oldM, vision: oldV, visual: oldVV, ...legacy } = x({ media: undefined, vision: undefined, visual: undefined });
  assert.deepEqual(news, legacy);
});

for (const value of [undefined, null, [], "ok", {}, { status: "failed", observations: "text" }, { status: "ok", observations: "  " }, { status: "ok", observations: 1 }]) {
  test(`invalid/absent Vision becomes null: ${JSON.stringify(value)}`, () => {
    assert.equal(x({ vision: value }).vision, null);
  });
}
test("Vision visibleText is nullable, observations preserved verbatim", () => {
  assert.deepEqual(normalizeVision({ status: "ok", observations: " text ", visibleText: 99 }), {
    status: "ok", observations: " text ", visibleText: null,
  });
});

for (const value of [undefined, null, [], "4", {}, { value: "4", roles: [] }, { value: 0, roles: [] }, { value: 6, roles: [] }, { value: 3.5, roles: [] }, { value: 4 }, { value: 4, roles: "diagram" }, { value: 4, roles: ["invalid"] }, { value: 4, roles: [null] }]) {
  test(`invalid/absent Visual resets whole object: ${JSON.stringify(value)}`, () => {
    assert.deepEqual(x({ visual: value }).visual, { value: null, roles: [] });
    assert.equal(candidates([{ ...x(), visual: value }]).candidateCount, 0);
  });
}
test("Visual roles use canonical allowlist order, deduplicate and remove mixed other", () => {
  assert.deepEqual(normalizeVisual({ value: 5, roles: [...VISUAL_ROLES].reverse().concat("diagram") }), {
    value: 5, roles: VISUAL_ROLES.filter((r) => r !== "other"),
  });
  assert.deepEqual(normalizeVisual({ value: null, roles: ["other"] }), { value: null, roles: ["other"] });
});

test("media preserves multiple entries and preview-only video; projects six keys", () => {
  assert.deepEqual(normalizeXMedia(media), media);
  assert.deepEqual(normalizeXMedia([null, false, [], {}, ...media]), media);
  assert.deepEqual(normalizeXMedia(undefined), []);
});
for (const url of ["javascript:alert(1)", "data:image/png,aaa", "file:///tmp/a", "blob:https://x.com/a", "http://pbs.twimg.com/media/a", "https://evil.test/a", "https://pbs.twimg.com.evil.test/a", "https://u:p@pbs.twimg.com/media/a", "https://pbs.twimg.com:8443/media/a", "https://pbs.twimg.com/media/a?token=secret", "https://pbs.twimg.com/profile_images/a"]) {
  test(`unsafe media URL cannot qualify: ${url}`, () => {
    assert.equal(candidates([{ ...x(), media: [{ url }] }]).candidateCount, 0);
  });
}
test("media strips arbitrary query and fragment, normalizes invalid fields", () => {
  assert.deepEqual(normalizeXMedia([{ url: "https://pbs.twimg.com/media/a?name=orig&tracking=x&format=jpg#fragment", type: "bad", altText: {}, width: -1, height: "4" }]), [{
    type: "unknown", url: "https://pbs.twimg.com/media/a?format=jpg&name=orig", previewUrl: null, altText: null, width: null, height: null,
  }]);
});
test("legacy public feed remains valid and gains neutral fields", () => {
  const normalized = normalizeXFeed(validateXFeed(loadFixture("valid-10.json")), { generatedAt: NOW });
  assert.equal(normalized.items.length, 10);
  for (const item of normalized.items) {
    assert.deepEqual(item.media, []);
    assert.equal(item.vision, null);
    assert.deepEqual(item.visual, { value: null, roles: [] });
  }
});

test("normalize → file → Unified Pool preserves X metadata, Web and identity rules", async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const feed = loadFixture("valid-10.json");
  Object.assign(feed.items[0], { media, vision, visual });
  const normalized = normalizeXFeed(validateXFeed(feed), { generatedAt: NOW });
  const web = loadFixture("unify/web-4.json");
  const xPath = path.join(dir, "x.json");
  const webPath = path.join(dir, "web.json");
  await writeFile(xPath, JSON.stringify(normalized));
  await writeFile(webPath, JSON.stringify(web));
  const inputsConfig = { schemaVersion: 1, inputs: [
    { id: "x", path: xPath, required: true }, { id: "web", path: webPath, required: true },
  ] };
  const { document } = await unifyNewsPool({ inputsConfig, now: () => NOW });
  assert.equal(document.items.length, 14);
  for (const item of [...normalized.items, ...web.items]) {
    assert.deepEqual(document.items.find((i) => i.id === item.id), item);
  }
  assert.equal(buildReferencesCandidates(document).candidateCount, 1);
  // Duplicate URLs remain separate; duplicate IDs still fail fast.
  normalized.items[1].source.url = normalized.items[0].source.url;
  await writeFile(xPath, JSON.stringify(normalized));
  assert.equal((await unifyNewsPool({ inputsConfig })).itemCount, 14);
  normalized.items[1].id = normalized.items[0].id;
  await writeFile(xPath, JSON.stringify(normalized));
  await assert.rejects(unifyNewsPool({ inputsConfig }), /Duplicate item.id/);
});

for (const value of [1, 2, 3, 4, 5, null]) {
  test(`References value ${value} eligibility`, () => {
    const doc = candidates([x({ visual: { value, roles: [] }, vision: undefined })]);
    assert.equal(doc.candidateCount, value >= 3 ? 1 : 0);
    if (doc.candidateCount) assert.equal(doc.items[0].vision, null);
  });
}
test("missing/unusable media excluded; valid value does not require Vision", () => {
  for (const m of [undefined, null, [], {}, [{}]]) assert.equal(candidates([{ ...x(), media: m }]).candidateCount, 0);
  for (const v of [undefined, null, {}, { status: "failed" }]) {
    assert.equal(candidates([{ ...x(), vision: v }]).candidateCount, 1);
  }
});
test("empty, Web-only, legacy and mixed pool counts; Web cannot qualify", () => {
  const web = loadFixture("unify/web-4.json").items.map((i) => ({ ...i, media, vision, visual, sourceType: "x" }));
  assert.equal(candidates([]).candidateCount, 0);
  assert.equal(candidates(web).candidateCount, 0);
  const legacy = loadFixture("unify/x-3.json").items;
  assert.equal(candidates(legacy).candidateCount, 0);
  const mixed = candidates([...web, ...legacy, x()]);
  assert.equal(mixed.sourcePool.itemCount, 8);
  assert.equal(mixed.candidateCount, 1);
});
test("value descending then ID ascending independent of input order and scores", () => {
  const items = [x({ id: "b", visual: { value: 3, roles: [] } }), x({ id: "a", visual: { value: 3, roles: [] } }), x({ id: "c", visual: { value: 5, roles: [] } }), x({ id: "d" })];
  const snapshot = structuredClone(items);
  const doc = candidates(items);
  assert.deepEqual(doc.items.map((i) => i.source.originalId), ["c", "d", "a", "b"]);
  assert.deepEqual(doc, candidates([...items].reverse()));
  assert.deepEqual(doc, candidates(items));
  assert.deepEqual(items, snapshot);
  assert.equal(doc.threshold, DEFAULT_REFERENCES_THRESHOLD);
  assert.equal(candidates(items, { threshold: 4 }).candidateCount, 2);
  assert.equal(candidates(items, { threshold: 5 }).candidateCount, 1);
  for (const threshold of [null, 0, 6, 3.1, "3"]) assert.throws(() => candidates(items, { threshold }), /threshold/);
  const changed = items.map((i) => ({ ...i, scores: Object.fromEntries(Object.keys(i.scores).map((k) => [k, 5])), collectedAt: "2099-01-01" }));
  assert.deepEqual(doc, candidates(changed));
});
test("candidate projection excludes raw text, scores and arbitrary source/author fields", () => {
  const item = x();
  item.rawText = "private";
  item.source.secret = "private";
  item.source.author.secret = "private";
  const candidate = candidates([item]).items[0];
  assert.deepEqual(Object.keys(candidate), ["id", "source", "title", "summary", "publishedAt", "media", "vision", "visual"]);
  assert.deepEqual(candidate.media, media);
  assert.deepEqual(candidate.visual.roles, visual.roles);
  assert.equal(JSON.stringify(candidate).includes("private"), false);
});
test("local References CLI writes artifact with no network/AI; missing/invalid input fails", async (t) => {
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", () => { networkCalls++; throw new Error("Network forbidden"); });
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const poolPath = path.join(dir, "pool.json");
  const outputPath = path.join(dir, "references.json");
  const stdout = collectWriter();
  const stderr = collectWriter();
  const options = { poolPath, outputPath, stdout, stderr, now: () => NOW };
  assert.equal(await runReferences(options), 1);
  assert.match(stderr.toString(), /missing:.*Run npm run unify/);
  await assert.rejects(readFile(outputPath), /ENOENT/);
  await writeFile(poolPath, "invalid");
  await assert.rejects(generateReferencesCandidates(options), /not valid JSON/);
  await writeFile(poolPath, JSON.stringify(pool([x()])));
  assert.equal(await runReferences(options), 0);
  const first = await readFile(outputPath, "utf8");
  assert.deepEqual(JSON.parse(first), candidates([x()]));
  assert.equal(await runReferences(options), 0);
  assert.equal(await readFile(outputPath, "utf8"), first);
  assert.equal(networkCalls, 0);
});
