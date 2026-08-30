import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CLUSTER_CONFIG_PATH } from "../src/config.js";
import { validateSemanticJudgment } from "../src/ai/semantic-judge.js";
import { validateClusterConfig } from "../src/sources/cluster-config.js";
import {
  generateSemanticCandidates,
} from "../src/sources/semantic-candidates.js";
import { validateSemanticConfig } from "../src/sources/semantic-config.js";
import { runSemanticPipeline } from "../src/sources/semantic-run.js";
import { parseSemanticArgs, runSemantic } from "../src/semantic.js";
import { collectWriter, makeTempDir } from "./helpers.js";

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

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function miloTriple() {
  return [
    makeItem({
      id: "web:a:1",
      title: "Alt-right troll Milo Yiannopoulos has been deported",
    }),
    makeItem({
      id: "web:b:2",
      title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
    }),
    makeItem({
      id: "web:c:3",
      title: "US sends Milo Yiannopoulos back to Britain after visa action",
    }),
  ];
}

function countingJudge(map = {}) {
  const state = { calls: 0 };
  const judge = async ({ itemA, itemB }) => {
    state.calls += 1;
    const key = pairKey(itemA.id, itemB.id);
    const result = map[key] || map.default;
    if (!result) {
      return {
        relationship: "different-event",
        confidence: 0.9,
        reason: "default different",
      };
    }
    if (result.throw) throw new Error(result.throw);
    return result;
  };
  return { judge, state };
}

async function applySemantic(items, judge, dir, extra = {}) {
  return runSemanticPipeline({
    applyAi: true,
    pool: makePool(items),
    semanticConfig: extra.semanticConfig || semanticConfig,
    clusterConfig,
    judge,
    cachePath: extra.cachePath ?? path.join(dir, "cache.json"),
    outputPath: extra.outputPath ?? path.join(dir, "news-semantic.json"),
    requestLimit: extra.requestLimit,
    now: () => "2026-08-30T17:00:00.000Z",
  });
}

describe("semantic candidates and judge", () => {
  it("Case A: candidate generator picks an obvious similar pair", () => {
    const candidates = generateSemanticCandidates(
      [
        makeItem({
          id: "web:a:1",
          title: "NASA Artemis II crew receives Congressional Space Medal of Honor",
        }),
        makeItem({
          id: "web:b:2",
          title: "NASA Artemis II crew receives the Congressional Space Medal of Honor",
        }),
        makeItem({
          id: "web:c:3",
          title: "Local bakery wins a village pie contest",
        }),
      ],
      semanticConfig.candidate
    );
    assert.ok(
      candidates.some(
        (candidate) =>
          pairKey(candidate.itemA, candidate.itemB) === pairKey("web:a:1", "web:b:2")
      )
    );
  });

  it("Case B: unrelated pair is not a candidate", () => {
    const candidates = generateSemanticCandidates(
      [
        makeItem({ id: "web:a:1", title: "Alpha story about rain in the mountains" }),
        makeItem({ id: "web:b:2", title: "Beta launch of a satellite this morning" }),
      ],
      semanticConfig.candidate
    );
    assert.equal(candidates.length, 0);
  });

  it("Case C: maxCandidatesPerItem is enforced", () => {
    const items = [
      makeItem({
        id: "web:hub:0",
        title: "Milo Yiannopoulos deported after commentary tour 0",
      }),
    ];
    for (let index = 1; index <= 6; index += 1) {
      items.push(
        makeItem({
          id: `web:spoke:${index}`,
          title: `Milo Yiannopoulos deported after commentary tour ${index}`,
        })
      );
    }
    const candidates = generateSemanticCandidates(items, {
      ...semanticConfig.candidate,
      maxCandidatesPerItem: 2,
      maxTotalCandidates: 100,
    });
    const counts = new Map();
    for (const candidate of candidates) {
      counts.set(candidate.itemA, (counts.get(candidate.itemA) || 0) + 1);
      counts.set(candidate.itemB, (counts.get(candidate.itemB) || 0) + 1);
    }
    for (const count of counts.values()) {
      assert.ok(count <= 2);
    }
  });

  it("Case D: maxTotalCandidates is enforced", () => {
    const items = [];
    for (let index = 0; index < 8; index += 1) {
      items.push(
        makeItem({
          id: `web:n:${index}`,
          title: `Milo Yiannopoulos deported after commentary tour ${index}`,
        })
      );
    }
    const candidates = generateSemanticCandidates(items, {
      ...semanticConfig.candidate,
      maxCandidatesPerItem: 10,
      maxTotalCandidates: 3,
    });
    assert.equal(candidates.length, 3);
  });

  it("Case E: candidate ordering is deterministic", () => {
    const items = [
      makeItem({
        id: "web:z:1",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
      makeItem({
        id: "web:a:2",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({ id: "web:m:3", title: "Unrelated bakery contest winner announced" }),
    ];
    const first = generateSemanticCandidates(items, semanticConfig.candidate);
    const second = generateSemanticCandidates([...items].reverse(), semanticConfig.candidate);
    assert.deepEqual(
      first.map((candidate) => `${candidate.itemA}|${candidate.itemB}`),
      second.map((candidate) => `${candidate.itemA}|${candidate.itemB}`)
    );
  });

  it("Case F: Milo-style titles become a candidate", () => {
    const candidates = generateSemanticCandidates(
      [
        makeItem({
          id: "web:the-verge:1",
          source: { provider: "the-verge" },
          title: "Alt-right troll Milo Yiannopoulos has been deported",
        }),
        makeItem({
          id: "web:bbc-world:2",
          source: { provider: "bbc-world" },
          title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
        }),
      ],
      semanticConfig.candidate
    );
    assert.equal(candidates.length, 1);
    assert.ok(candidates[0].titleSimilarity >= 0.3);
    assert.ok(candidates[0].sharedProperNouns.includes("milo"));
    assert.ok(candidates[0].sharedProperNouns.includes("yiannopoulos"));
  });

  it("Case G: mock same-event merges into one cluster", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
    ];
    const { judge } = countingJudge({
      default: {
        relationship: "same-event",
        confidence: 0.94,
        reason: "same deportation",
      },
    });
    const result = await applySemantic(items, judge, dir);
    assert.equal(result.stats.sameEvent, 1);
    const multi = result.clusters.filter((cluster) => cluster.itemIds.length > 1);
    assert.equal(multi.length, 1);
    assert.equal(multi[0].itemIds.length, 2);
  });

  it("Case H: mock related-event is stored but not clustered", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
    ];
    const { judge } = countingJudge({
      default: {
        relationship: "related-event",
        confidence: 0.7,
        reason: "same person, later reaction",
      },
    });
    const result = await applySemantic(items, judge, dir);
    assert.equal(result.stats.relatedEvent, 1);
    assert.equal(result.clusters.filter((cluster) => cluster.itemIds.length > 1).length, 0);
    assert.equal(result.judgments[0].relationship, "related-event");
  });

  it("Case I: mock different-event stays in separate clusters", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
    ];
    const { judge } = countingJudge({
      default: {
        relationship: "different-event",
        confidence: 0.8,
        reason: "different concrete news",
      },
    });
    const result = await applySemantic(items, judge, dir);
    assert.equal(result.stats.differentEvent, 1);
    assert.equal(result.clusters.length, 2);
  });

  it("Case J: invalid AI enum is failed and does not merge", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
    ];
    const { judge } = countingJudge({
      default: { relationship: "same-story", confidence: 0.9, reason: "bad enum" },
    });
    const result = await applySemantic(items, judge, dir);
    assert.equal(result.stats.failed, 1);
    assert.equal(result.judgments[0].status, "failed");
    assert.equal(result.clusters.filter((cluster) => cluster.itemIds.length > 1).length, 0);
    const invalid = validateSemanticJudgment({
      relationship: "same-story",
      confidence: 0.9,
      reason: "bad",
    });
    assert.equal(invalid.status, "failed");
  });

  it("Case K: AI request failure does not merge", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
    ];
    const { judge } = countingJudge({
      default: { throw: "network down" },
    });
    const result = await applySemantic(items, judge, dir);
    assert.equal(result.stats.failed, 1);
    assert.equal(result.clusters.filter((cluster) => cluster.itemIds.length > 1).length, 0);
  });

  it("Case L: cache hit does not call the judge", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
    ];
    const cachePath = path.join(dir, "cache.json");
    const first = countingJudge({
      default: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "cached later",
      },
    });
    await applySemantic(items, first.judge, dir, { cachePath });
    const second = countingJudge({
      default: {
        relationship: "different-event",
        confidence: 0.1,
        reason: "should not run",
      },
    });
    const result = await applySemantic(items, second.judge, dir, { cachePath });
    assert.equal(second.state.calls, 0);
    assert.equal(result.stats.cacheHits, 1);
    assert.equal(result.stats.sameEvent, 1);
  });

  it("Case M: content change causes a cache miss", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    const firstItems = [
      makeItem({
        id: "web:a:1",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
    ];
    await applySemantic(
      firstItems,
      countingJudge({
        default: { relationship: "same-event", confidence: 0.9, reason: "first" },
      }).judge,
      dir,
      { cachePath }
    );
    const changed = [
      firstItems[0],
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported after a new ruling",
      }),
    ];
    const second = countingJudge({
      default: { relationship: "related-event", confidence: 0.6, reason: "changed" },
    });
    const result = await applySemantic(changed, second.judge, dir, { cachePath });
    assert.equal(second.state.calls, 1);
    assert.equal(result.stats.cacheMisses, 1);
    assert.equal(result.stats.relatedEvent, 1);
  });

  it("Case N: model or judgeVersion change causes a cache miss", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
    ];
    await applySemantic(
      items,
      countingJudge({
        default: { relationship: "same-event", confidence: 0.9, reason: "v1" },
      }).judge,
      dir,
      { cachePath }
    );
    const second = countingJudge({
      default: { relationship: "different-event", confidence: 0.4, reason: "v2" },
    });
    const result = await applySemantic(items, second.judge, dir, {
      cachePath,
      semanticConfig: { ...semanticConfig, model: "other-model" },
    });
    assert.equal(second.state.calls, 1);
    assert.equal(result.stats.cacheMisses, 1);

    const versionDir = await makeTempDir();
    const versionCache = path.join(versionDir, "cache.json");
    await applySemantic(
      items,
      countingJudge({
        default: { relationship: "same-event", confidence: 0.9, reason: "v1" },
      }).judge,
      versionDir,
      { cachePath: versionCache }
    );
    const versionJudge = countingJudge({
      default: { relationship: "different-event", confidence: 0.4, reason: "v2" },
    });
    const versionResult = await applySemantic(items, versionJudge.judge, versionDir, {
      cachePath: versionCache,
      semanticConfig: { ...semanticConfig, judgeVersion: "semantic-judge-v2" },
    });
    assert.equal(versionJudge.state.calls, 1);
    assert.equal(versionResult.stats.cacheMisses, 1);
  });

  it("Case O: same-event relationships form a transitive cluster", async () => {
    const dir = await makeTempDir();
    const items = miloTriple();
    const { judge } = countingJudge({
      [pairKey("web:a:1", "web:b:2")]: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "A-B",
      },
      [pairKey("web:b:2", "web:c:3")]: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "B-C",
      },
      [pairKey("web:a:1", "web:c:3")]: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "A-C",
      },
    });
    const result = await applySemantic(items, judge, dir);
    const multi = result.clusters.filter((cluster) => cluster.itemIds.length > 1);
    assert.equal(multi.length, 1);
    assert.equal(multi[0].itemIds.length, 3);
  });

  it("Case P: different-event inside a same-event component is a conflict", async () => {
    const dir = await makeTempDir();
    const items = miloTriple();
    const { judge } = countingJudge({
      [pairKey("web:a:1", "web:b:2")]: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "A-B",
      },
      [pairKey("web:b:2", "web:c:3")]: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "B-C",
      },
      [pairKey("web:a:1", "web:c:3")]: {
        relationship: "different-event",
        confidence: 0.9,
        reason: "A-C conflict",
      },
    });
    const result = await applySemantic(items, judge, dir);
    assert.ok(result.conflicts.length >= 1);
    const multi = result.clusters.filter((cluster) => cluster.itemIds.length > 1);
    assert.equal(multi.length, 1);
    assert.equal(multi[0].itemIds.length, 2);
    const together = new Set(multi[0].itemIds);
    assert.equal(
      together.has("web:a:1") && together.has("web:c:3"),
      false,
      "A and C must not merge across an explicit different-event"
    );
  });

  it("Case Q: every item belongs to exactly one semantic cluster", async () => {
    const dir = await makeTempDir();
    const items = [
      makeItem({
        id: "web:a:1",
        title: "Alt-right troll Milo Yiannopoulos has been deported",
      }),
      makeItem({
        id: "web:b:2",
        title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
      }),
      makeItem({ id: "web:c:3", title: "Unrelated bakery contest winner announced" }),
    ];
    const { judge } = countingJudge({
      default: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "same",
      },
    });
    const result = await applySemantic(items, judge, dir);
    const flattened = result.clusters.flatMap((cluster) => cluster.itemIds);
    assert.equal(flattened.length, items.length);
    assert.equal(new Set(flattened).size, items.length);
  });

  it("Case R: dry-run makes zero judge calls", async () => {
    const dir = await makeTempDir();
    const { judge, state } = countingJudge();
    const result = await runSemanticPipeline({
      applyAi: false,
      pool: makePool([
        makeItem({
          id: "web:a:1",
          title: "Alt-right troll Milo Yiannopoulos has been deported",
        }),
        makeItem({
          id: "web:b:2",
          title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
        }),
      ]),
      semanticConfig,
      clusterConfig,
      judge,
      candidatesPath: path.join(dir, "candidates.json"),
    });
    assert.equal(state.calls, 0);
    assert.equal(result.judgeCalls, 0);
    assert.equal(result.stats.dryRun, true);
    assert.ok(result.stats.candidateCount >= 1);
  });

  it("Case S: semantic output and cache writes are atomic", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "out", "news-semantic.json");
    const cachePath = path.join(dir, "out", "cache.json");
    const { judge } = countingJudge({
      default: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "ok",
      },
    });
    await applySemantic(
      [
        makeItem({
          id: "web:a:1",
          title: "Alt-right troll Milo Yiannopoulos has been deported",
        }),
        makeItem({
          id: "web:b:2",
          title: "Right-wing commentator Milo Yiannopoulos deported from US to UK",
        }),
      ],
      judge,
      dir,
      { outputPath, cachePath }
    );
    JSON.parse(await readFile(outputPath, "utf8"));
    JSON.parse(await readFile(cachePath, "utf8"));
    const leftover = (await readdir(path.dirname(outputPath))).filter((name) =>
      name.endsWith(".tmp")
    );
    assert.deepEqual(leftover, []);
  });

  it("Case W: --limit 1 makes at most one judge call", async () => {
    const dir = await makeTempDir();
    const { judge, state } = countingJudge({
      default: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "limited",
      },
    });
    const result = await applySemantic(miloTriple(), judge, dir, {
      requestLimit: 1,
    });
    assert.ok(result.candidates.length >= 2);
    assert.ok(state.calls <= 1);
    assert.equal(result.judgeCalls, 1);
    assert.equal(result.stats.unjudged, result.candidates.length - 1);
  });

  it("Case X: cache hits do not count toward --limit 1", async () => {
    const dir = await makeTempDir();
    const cachePath = path.join(dir, "cache.json");
    await applySemantic(
      miloTriple(),
      countingJudge({
        default: {
          relationship: "related-event",
          confidence: 0.7,
          reason: "first",
        },
      }).judge,
      dir,
      { cachePath, requestLimit: 1 }
    );
    const second = countingJudge({
      default: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "should run at most once",
      },
    });
    const result = await applySemantic(miloTriple(), second.judge, dir, {
      cachePath,
      requestLimit: 1,
    });
    assert.ok(result.stats.cacheHits >= 1);
    assert.ok(second.state.calls <= 1);
    assert.equal(result.judgeCalls, 1);
  });

  it("Case Y: candidates past the limit are unjudged, not different-event", async () => {
    const dir = await makeTempDir();
    const { judge } = countingJudge({
      default: {
        relationship: "same-event",
        confidence: 0.9,
        reason: "only the first request",
      },
    });
    const result = await applySemantic(miloTriple(), judge, dir, {
      requestLimit: 1,
    });
    const unjudged = result.judgments.filter(
      (judgment) => judgment.status === "unjudged"
    );
    assert.ok(unjudged.length >= 1);
    for (const judgment of unjudged) {
      assert.equal(judgment.relationship, null);
      assert.notEqual(judgment.relationship, "different-event");
      assert.notEqual(judgment.status, "ok");
    }
    assert.equal(result.stats.differentEvent, 0);
    const multi = result.clusters.filter((cluster) => cluster.itemIds.length > 1);
    assert.equal(multi.length, 1);
    assert.equal(multi[0].itemIds.length, 2);
  });

  it("Case Z: invalid --limit fails", async () => {
    assert.throws(() => parseSemanticArgs(["--apply-ai", "--limit", "0"]));
    assert.throws(() => parseSemanticArgs(["--apply-ai", "--limit", "-1"]));
    assert.throws(() => parseSemanticArgs(["--apply-ai", "--limit", "abc"]));
    const stderr = collectWriter();
    const code = await runSemantic({
      applyAi: true,
      requestLimit: 0,
      pool: makePool(miloTriple()),
      semanticConfig,
      clusterConfig,
      judge: countingJudge().judge,
      stdout: collectWriter(),
      stderr,
    });
    assert.equal(code, 1);
    assert.match(stderr.toString(), /limit/i);
  });
});
