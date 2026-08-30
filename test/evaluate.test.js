import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { EVALUATION_CONFIG_PATH } from "../src/config.js";
import { runEvaluate } from "../src/evaluate.js";
import { computeBaseScore } from "../src/lib/evaluation-score.js";
import { ValidationError } from "../src/lib/errors.js";
import {
  computeClusterSignals,
  selectRepresentative,
  validateEvaluatedClusters,
} from "../src/sources/evaluation-clusters.js";
import { validateEvaluationConfig } from "../src/sources/evaluation-config.js";
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
    scores: overrides.scores || {
      ...NULL_SCORES,
      importance: 5,
      informationValue: 5,
    },
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

function makeSemantic(clusters, extra = {}) {
  return {
    schemaVersion: 1,
    generatedAt: extra.generatedAt || "2026-08-30T18:18:27.736Z",
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

async function evaluateItems(items, clusters, dir, extra = {}) {
  return runEvaluationPipeline({
    dryRun: extra.dryRun === true,
    evaluationConfig,
    semantic: makeSemantic(clusters),
    pool: makePool(items),
    outputPath: extra.outputPath ?? path.join(dir, "news-evaluated.json"),
    sourceSemanticPath: "data/processed/news-semantic.json",
    now: extra.now || (() => "2026-08-31T00:00:00.000Z"),
  });
}

describe("news evaluation foundation", () => {
  it("Case A: singleton cluster representative", () => {
    const item = makeItem({
      id: "web:a:1",
      title: "Singleton title",
      summary: "Singleton summary",
    });
    const representative = selectRepresentative([item]);
    assert.equal(representative.id, "web:a:1");
  });

  it("Case B: multi-item cluster representative is deterministic", () => {
    const older = makeItem({
      id: "web:z:old",
      title: "Older",
      publishedAt: "2026-08-29T10:00:00.000Z",
      collectedAt: "2026-08-31T10:00:00.000Z",
    });
    const newer = makeItem({
      id: "web:a:new",
      title: "Newer",
      publishedAt: "2026-08-30T10:00:00.000Z",
      collectedAt: "2026-08-29T10:00:00.000Z",
    });
    assert.equal(selectRepresentative([older, newer]).id, "web:a:new");
    assert.equal(selectRepresentative([newer, older]).id, "web:a:new");

    const samePublish = [
      makeItem({
        id: "web:b:late-collect",
        publishedAt: "2026-08-30T10:00:00.000Z",
        collectedAt: "2026-08-30T12:00:00.000Z",
        title: "",
        summary: "",
      }),
      makeItem({
        id: "web:a:early-collect",
        publishedAt: "2026-08-30T10:00:00.000Z",
        collectedAt: "2026-08-30T11:00:00.000Z",
        title: "Has title",
        summary: "Has summary",
      }),
    ];
    assert.equal(selectRepresentative(samePublish).id, "web:b:late-collect");
  });

  it("Case B2: representative date edge cases", () => {
    const tiedDates = {
      publishedAt: "2026-08-30T10:00:00.000Z",
      collectedAt: "2026-08-30T11:00:00.000Z",
    };

    const valid = makeItem({
      id: "web:z:valid",
      publishedAt: "2026-08-30T10:00:00.000Z",
      collectedAt: null,
      title: "",
      summary: "",
    });
    const missing = makeItem({
      id: "web:a:null",
      publishedAt: null,
      collectedAt: "2026-08-31T10:00:00.000Z",
      title: "Has title",
      summary: "Has summary",
    });
    assert.equal(selectRepresentative([valid, missing]).id, "web:z:valid");
    assert.equal(selectRepresentative([missing, valid]).id, "web:z:valid");

    const empty = makeItem({
      id: "web:a:empty",
      publishedAt: "",
      collectedAt: "2026-08-31T10:00:00.000Z",
      title: "Has title",
      summary: "Has summary",
    });
    assert.equal(selectRepresentative([valid, empty]).id, "web:z:valid");
    assert.equal(selectRepresentative([empty, valid]).id, "web:z:valid");

    const invalid = makeItem({
      id: "web:a:invalid",
      publishedAt: "not-a-date",
      collectedAt: "2026-08-31T10:00:00.000Z",
      title: "Has title",
      summary: "Has summary",
    });
    assert.equal(selectRepresentative([valid, invalid]).id, "web:z:valid");
    assert.equal(selectRepresentative([invalid, valid]).id, "web:z:valid");

    const newer = makeItem({
      id: "web:a:older-id",
      publishedAt: "2026-08-30T12:00:00.000Z",
      collectedAt: "2026-08-29T10:00:00.000Z",
      title: "",
      summary: "",
    });
    const older = makeItem({
      id: "web:z:newer-id",
      publishedAt: "2026-08-30T11:00:00.000Z",
      collectedAt: "2026-08-31T10:00:00.000Z",
      title: "Has title",
      summary: "Has summary",
    });
    assert.equal(selectRepresentative([older, newer]).id, "web:a:older-id");
    assert.equal(selectRepresentative([newer, older]).id, "web:a:older-id");

    const laterCollect = makeItem({
      id: "web:z:later",
      ...tiedDates,
      collectedAt: "2026-08-30T12:00:00.000Z",
      title: "",
      summary: "",
    });
    const earlierCollect = makeItem({
      id: "web:a:earlier",
      ...tiedDates,
      collectedAt: "2026-08-30T11:00:00.000Z",
      title: "Has title",
      summary: "Has summary",
    });
    assert.equal(selectRepresentative([laterCollect, earlierCollect]).id, "web:z:later");
    assert.equal(selectRepresentative([earlierCollect, laterCollect]).id, "web:z:later");

    const collectedValid = makeItem({
      id: "web:z:collected-valid",
      publishedAt: null,
      collectedAt: "2026-08-30T12:00:00.000Z",
      title: "",
      summary: "",
    });
    const collectedMissing = makeItem({
      id: "web:a:collected-null",
      publishedAt: "",
      collectedAt: null,
      title: "Has title",
      summary: "Has summary",
    });
    assert.equal(
      selectRepresentative([collectedValid, collectedMissing]).id,
      "web:z:collected-valid"
    );
    const collectedInvalid = makeItem({
      id: "web:a:collected-invalid",
      publishedAt: "not-a-date",
      collectedAt: "tomorrow",
      title: "Has title",
      summary: "Has summary",
    });
    assert.equal(
      selectRepresentative([collectedValid, collectedInvalid]).id,
      "web:z:collected-valid"
    );

    const withTitle = makeItem({
      id: "web:z:untitled",
      ...tiedDates,
      title: "",
      summary: "Has summary",
    });
    const titled = makeItem({
      id: "web:a:titled",
      ...tiedDates,
      title: "Has title",
      summary: "",
    });
    assert.equal(selectRepresentative([withTitle, titled]).id, "web:a:titled");
    assert.equal(selectRepresentative([titled, withTitle]).id, "web:a:titled");

    const withSummary = makeItem({
      id: "web:z:no-summary",
      ...tiedDates,
      title: "Same title",
      summary: "",
    });
    const summarized = makeItem({
      id: "web:a:summary",
      ...tiedDates,
      title: "Same title",
      summary: "Has summary",
    });
    assert.equal(selectRepresentative([withSummary, summarized]).id, "web:a:summary");
    assert.equal(selectRepresentative([summarized, withSummary]).id, "web:a:summary");

    const laterId = makeItem({
      id: "web:z:later-id",
      ...tiedDates,
      title: "Same title",
      summary: "Same summary",
    });
    const earlierId = makeItem({
      id: "web:a:earlier-id",
      ...tiedDates,
      title: "Same title",
      summary: "Same summary",
    });
    assert.equal(selectRepresentative([laterId, earlierId]).id, "web:a:earlier-id");
    assert.equal(selectRepresentative([earlierId, laterId]).id, "web:a:earlier-id");
  });

  it("Case C: sourceCount uses distinct URLs and ignores null", () => {
    const items = [
      makeItem({
        id: "web:a:1",
        source: { url: "https://example.com/a?utm_source=x" },
      }),
      makeItem({
        id: "web:b:2",
        source: { url: "https://example.com/a?utm_source=x" },
      }),
      makeItem({
        id: "web:c:3",
        source: { url: "https://example.com/b" },
      }),
      makeItem({
        id: "web:d:4",
        source: { url: null },
      }),
    ];
    const signals = computeClusterSignals(items);
    assert.equal(signals.sourceCount, 2);
  });

  it("Case D: sourceDiversity uses distinct providers", () => {
    const mixed = computeClusterSignals([
      makeItem({ id: "web:a:1", source: { provider: "bbc-world" } }),
      makeItem({ id: "web:b:2", source: { provider: "the-verge" } }),
    ]);
    assert.equal(mixed.sourceDiversity, 2);
    const same = computeClusterSignals([
      makeItem({ id: "web:a:1", source: { provider: "nasa-news" } }),
      makeItem({ id: "web:b:2", source: { provider: "nasa-news" } }),
    ]);
    assert.equal(same.sourceDiversity, 1);
  });

  it("Case E: sourceTypes are sorted deterministically", () => {
    const signals = computeClusterSignals([
      makeItem({ id: "x:a:1", source: { type: "x", provider: "x-timeline-collector" } }),
      makeItem({ id: "web:b:2", source: { type: "web", provider: "bbc-world" } }),
      makeItem({ id: "web:c:3", source: { type: "web", provider: "nasa-news" } }),
    ]);
    assert.deepEqual(signals.sourceTypes, ["web", "x"]);
  });

  it("Case F: providers are sorted deterministically", () => {
    const signals = computeClusterSignals([
      makeItem({ id: "web:a:1", source: { provider: "the-verge" } }),
      makeItem({ id: "web:b:2", source: { provider: "bbc-world" } }),
      makeItem({ id: "web:c:3", source: { provider: "bbc-world" } }),
    ]);
    assert.deepEqual(signals.providers, ["bbc-world", "the-verge"]);
  });

  it("Case G: all scores null → baseScore null", () => {
    assert.equal(
      computeBaseScore({
        importance: null,
        informationValue: null,
        impact: null,
        novelty: null,
        personalRelevance: null,
      }),
      null
    );
  });

  it("Case H: valid 5 scores → weighted baseScore", () => {
    assert.equal(
      computeBaseScore({
        importance: 5,
        informationValue: 4,
        impact: 3,
        novelty: 2,
        personalRelevance: 1,
      }),
      3.5
    );
    assert.equal(
      computeBaseScore({
        importance: 5,
        informationValue: 5,
        impact: 5,
        novelty: 5,
        personalRelevance: 5,
      }),
      5
    );
  });

  it("Case I: score outside 1..5 → baseScore null", () => {
    assert.equal(
      computeBaseScore({
        importance: 6,
        informationValue: 4,
        impact: 3,
        novelty: 2,
        personalRelevance: 1,
      }),
      null
    );
    assert.equal(
      computeBaseScore({
        importance: 0,
        informationValue: 4,
        impact: 3,
        novelty: 2,
        personalRelevance: 1,
      }),
      null
    );
  });

  it("Case J: missing score → baseScore null", () => {
    assert.equal(
      computeBaseScore({
        importance: 5,
        informationValue: 4,
        impact: 3,
        novelty: 2,
      }),
      null
    );
  });

  it("Case K: duplicate cluster membership fails", async () => {
    const dir = await makeTempDir();
    const items = [makeItem({ id: "web:a:1" }), makeItem({ id: "web:b:2" })];
    await assert.rejects(
      () =>
        evaluateItems(
          items,
          [
            clusterOf("cluster:a", ["web:a:1", "web:b:2"]),
            clusterOf("cluster:b", ["web:a:1"]),
          ],
          dir
        ),
      (error) => error instanceof ValidationError
    );
  });

  it("Case L: unknown itemId fails", async () => {
    const dir = await makeTempDir();
    await assert.rejects(
      () =>
        evaluateItems(
          [makeItem({ id: "web:a:1" })],
          [clusterOf("cluster:a", ["web:a:1", "web:missing:2"])],
          dir
        ),
      (error) => error instanceof ValidationError
    );
  });

  it("Case M: representative must belong to cluster", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({ id: "web:a:1", title: "A" }),
      makeItem({ id: "web:b:2", title: "B" }),
    ];
    const result = await evaluateItems(
      items,
      [clusterOf("cluster:ab", ["web:a:1", "web:b:2"])],
      dir
    );
    const cluster = result.clusters[0];
    assert.equal(cluster.itemIds.includes(cluster.representative.itemId), true);
    assert.throws(
      () =>
        validateEvaluatedClusters(
          items,
          [
            {
              ...cluster,
              representative: { ...cluster.representative, itemId: "web:outsider:9" },
            },
          ],
          [clusterOf("cluster:ab", ["web:a:1", "web:b:2"])]
        ),
      ValidationError
    );
  });

  it("Case N: dry-run does not write", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "news-evaluated.json");
    const items = [makeItem({ id: "web:a:1" })];
    const result = await evaluateItems(items, [clusterOf("cluster:a", ["web:a:1"])], dir, {
      dryRun: true,
      outputPath,
    });
    assert.equal(result.dryRun, true);
    await assert.rejects(() => readFile(outputPath), { code: "ENOENT" });
  });

  it("Case O: normal run writes atomically", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "out", "news-evaluated.json");
    const result = await evaluateItems(
      [makeItem({ id: "web:a:1", title: "Only" })],
      [clusterOf("cluster:a", ["web:a:1"])],
      dir,
      { outputPath }
    );
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.clusters.length, 1);
    assert.equal(written.clusters[0].status, "unevaluated");
    assert.equal(written.clusters[0].baseScore, null);
    assert.equal(written.clusters[0].scores.importance, null);
    assert.equal(result.clusters[0].representative.itemId, "web:a:1");
    const leftover = (await readdir(path.dirname(outputPath))).filter((name) =>
      name.endsWith(".tmp")
    );
    assert.deepEqual(leftover, []);
  });

  it("Case P: existing semantic input is not mutated", async () => {
    const dir = await makeTempDir();
    const semanticPath = path.join(dir, "news-semantic.json");
    const outputPath = path.join(dir, "news-evaluated.json");
    const items = [makeItem({ id: "web:a:1" }), makeItem({ id: "web:b:2" })];
    const semantic = makeSemantic([clusterOf("cluster:ab", ["web:a:1", "web:b:2"])]);
    await writeFile(semanticPath, `${JSON.stringify(semantic, null, 2)}\n`, "utf8");
    const before = await readFile(semanticPath, "utf8");
    await runEvaluationPipeline({
      evaluationConfig,
      semanticPath,
      pool: makePool(items),
      outputPath,
      now: () => "2026-08-31T00:00:00.000Z",
    });
    const after = await readFile(semanticPath, "utf8");
    assert.equal(after, before);
  });

  it("Case Q: same input is deterministic except generatedAt", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:bbc:1",
        source: { provider: "bbc-world", url: "https://bbc.example/milo" },
        title: "Milo deported",
        publishedAt: "2026-08-30T10:00:00.000Z",
      }),
      makeItem({
        id: "web:verge:2",
        source: { provider: "the-verge", url: "https://verge.example/milo" },
        title: "Milo deported too",
        publishedAt: "2026-08-30T11:00:00.000Z",
      }),
    ];
    const clusters = [clusterOf("cluster:milo", ["web:bbc:1", "web:verge:2"])];
    const first = await evaluateItems(items, clusters, dir, {
      outputPath: path.join(dir, "a.json"),
      now: () => "2026-08-31T00:00:00.000Z",
    });
    const second = await evaluateItems(items, clusters, dir, {
      outputPath: path.join(dir, "b.json"),
      now: () => "2026-08-31T01:00:00.000Z",
    });
    const strip = (document) => {
      const copy = structuredClone(document);
      delete copy.generatedAt;
      return copy;
    };
    assert.deepEqual(strip(first.document), strip(second.document));
    assert.equal(first.clusters[0].representative.itemId, "web:verge:2");
    assert.notEqual(first.document.generatedAt, second.document.generatedAt);
  });

  it("does not copy upstream X scores into final scores", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "x:x:1",
        source: { type: "x", provider: "x-timeline-collector", url: "https://x.com/1" },
        scores: {
          informationValue: 5,
          personalRelevance: 4,
          impact: 3,
          attentionSignal: 2,
          importance: 5,
        },
      }),
    ];
    const result = await evaluateItems(items, [clusterOf("cluster:x", ["x:x:1"])], dir);
    assert.equal(result.clusters[0].scores.importance, null);
    assert.equal(result.clusters[0].scores.informationValue, null);
    assert.equal(result.clusters[0].baseScore, null);
  });

  it("CLI dry-run reports stats and does not write", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "news-evaluated.json");
    const stdout = collectWriter();
    const code = await runEvaluate({
      dryRun: true,
      evaluationConfig,
      semantic: makeSemantic([clusterOf("cluster:a", ["web:a:1"])]),
      pool: makePool([makeItem({ id: "web:a:1", title: "Preview" })]),
      outputPath,
      stdout,
      stderr: collectWriter(),
      now: () => "2026-08-31T00:00:00.000Z",
    });
    assert.equal(code, 0);
    assert.match(stdout.toString(), /News Evaluation dry-run/);
    assert.match(stdout.toString(), /unevaluated: 1/);
    await assert.rejects(() => readFile(outputPath), { code: "ENOENT" });
  });

  it("invalid semantic input fails without writing output", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "news-evaluated.json");
    const existing = path.join(dir, "keep.json");
    await writeFile(existing, '{"keep":true}\n', "utf8");
    const stderr = collectWriter();
    const code = await runEvaluate({
      evaluationConfig,
      semantic: { schemaVersion: 2, clusters: [] },
      pool: makePool([makeItem({ id: "web:a:1" })]),
      outputPath,
      stdout: collectWriter(),
      stderr,
    });
    assert.equal(code, 1);
    await assert.rejects(() => readFile(outputPath), { code: "ENOENT" });
    assert.equal(await readFile(existing, "utf8"), '{"keep":true}\n');
  });
});
