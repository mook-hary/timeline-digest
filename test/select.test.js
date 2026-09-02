import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  NEWS_EVALUATED_PATH,
  NEWS_SEMANTIC_PATH,
  SELECT_CONFIG_PATH,
} from "../src/config.js";
import { computeBaseScore } from "../src/lib/evaluation-score.js";
import { parseSelectArgs, runSelect } from "../src/select.js";
import {
  loadSelectConfig,
  validateSelectConfig,
} from "../src/sources/select-config.js";
import { eligibilityOf, failsQualityFloor } from "../src/sources/select-eligibility.js";
import {
  computeMajorRank,
  computePersonalRank,
  passesGeneralGate,
  passesMajorGate,
  passesPersonalGate,
} from "../src/sources/select-lanes.js";
import { titleOverlapEvidence } from "../src/sources/select-related-groups.js";
import { runSelectPipeline } from "../src/sources/select-run.js";
import { assignTopicGroup, keywordMatches } from "../src/sources/select-topics.js";
import { collectWriter, makeTempDir } from "./helpers.js";

const selectConfig = validateSelectConfig(
  JSON.parse(readFileSync(SELECT_CONFIG_PATH, "utf8"))
);

function scores(partial) {
  return {
    importance: 3,
    informationValue: 3,
    impact: 3,
    novelty: 3,
    personalRelevance: 3,
    ...partial,
  };
}

function makeCluster(overrides = {}) {
  const clusterId = overrides.clusterId || "cluster:a";
  const itemId = overrides.itemId || `item:${clusterId}`;
  const nextScores = overrides.scores === null ? {
    importance: null,
    informationValue: null,
    impact: null,
    novelty: null,
    personalRelevance: null,
  } : scores(overrides.scores || {});
  return {
    clusterId,
    itemIds: overrides.itemIds || [itemId],
    representative: {
      itemId,
      title: overrides.title || "Title",
      summary: overrides.summary || "Summary",
      category: overrides.category || "一般",
      publishedAt: overrides.publishedAt || "2026-08-30T12:00:00.000Z",
      source: {
        type: overrides.sourceType || "web",
        provider: overrides.provider || "bbc-world",
        url: overrides.url || "https://example.com/a",
      },
    },
    signals: {
      itemCount: (overrides.itemIds || [itemId]).length,
      sourceCount: 1,
      sourceDiversity: 1,
      sourceTypes: [overrides.sourceType || "web"],
      providers: [overrides.provider || "bbc-world"],
    },
    scores: nextScores,
    baseScore: Object.hasOwn(overrides, "baseScore")
      ? overrides.baseScore
      : computeBaseScore(nextScores),
    status: overrides.status || "evaluated",
  };
}

function makeEvaluated(clusters) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-01T07:36:24.849Z",
    clusters,
  };
}

function makeSemantic(extra = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-30T18:18:27.736Z",
    clusters: extra.clusters || [],
    judgments: extra.judgments || [],
  };
}

async function runSelectOn(clusters, extra = {}) {
  return runSelectPipeline({
    dryRun: extra.dryRun !== false,
    selectConfig: extra.selectConfig || selectConfig,
    evaluated: makeEvaluated(clusters),
    semantic: extra.semantic || makeSemantic(),
    outputPath: extra.outputPath,
    reviewPath: extra.reviewPath,
    now: extra.now || (() => "2026-09-01T10:00:00.000Z"),
  });
}

describe("editorial select v1", () => {
  it("loads and validates select config", async () => {
    const config = await loadSelectConfig(SELECT_CONFIG_PATH);
    assert.equal(config.policyId, "news-select-v1");
    assert.equal(config.digestTarget, 10);
    assert.equal(config.digestMax, 14);
  });

  it("rejects invalid select config", () => {
    assert.throws(
      () => validateSelectConfig({ schemaVersion: 2 }),
      /Unsupported select config schemaVersion/
    );
  });

  it("quality floor rejects IV 1 even with PR 5", () => {
    const next = scores({
      importance: 1,
      informationValue: 1,
      impact: 1,
      novelty: 1,
      personalRelevance: 5,
    });
    assert.equal(failsQualityFloor(next, selectConfig.qualityFloor), true);
    const cluster = makeCluster({
      clusterId: "cluster:pr",
      scores: next,
      sourceType: "x",
      title: "Roman telescope looks cool",
    });
    assert.equal(eligibilityOf(cluster, selectConfig.qualityFloor).reason, "below-quality-floor");
  });

  it("does not reject X solely because of source type", async () => {
    const cluster = makeCluster({
      clusterId: "cluster:x-major",
      title: "Kyiv weapons depot strike kills dozens",
      sourceType: "x",
      provider: "x-timeline-collector",
      scores: {
        importance: 5,
        informationValue: 4,
        impact: 5,
        novelty: 4,
        personalRelevance: 2,
      },
    });
    const result = await runSelectOn([cluster]);
    assert.equal(result.document.selected.length, 1);
    assert.equal(result.document.selected[0].clusterId, "cluster:x-major");
    assert.equal(result.document.selected[0].lane, "major");
  });

  it("unevaluated clusters cannot be selected", async () => {
    const cluster = makeCluster({
      clusterId: "cluster:uneval",
      status: "unjudged",
      scores: null,
      baseScore: null,
      title: "Kyiv weapons depot strike kills dozens",
    });
    const result = await runSelectOn([cluster]);
    assert.equal(result.document.selected.length, 0);
    assert.equal(result.document.rejected[0].rejectionReason, "not-evaluated");
  });

  it("major gate requires importance and impact thresholds", () => {
    assert.equal(
      passesMajorGate(
        scores({ importance: 4, impact: 3, informationValue: 3 }),
        selectConfig.majorGate
      ),
      true
    );
    assert.equal(
      passesMajorGate(
        scores({ importance: 4, impact: 2, informationValue: 5 }),
        selectConfig.majorGate
      ),
      false
    );
  });

  it("personal gate requires PR and IV thresholds", () => {
    assert.equal(
      passesPersonalGate(
        scores({ personalRelevance: 4, informationValue: 3 }),
        selectConfig.personalGate
      ),
      true
    );
    assert.equal(
      passesPersonalGate(
        scores({ personalRelevance: 5, informationValue: 2 }),
        selectConfig.personalGate
      ),
      false
    );
  });

  it("general gate uses baseScore threshold", () => {
    assert.equal(passesGeneralGate(2.7, selectConfig.generalMinBaseScore), true);
    assert.equal(passesGeneralGate(2.69, selectConfig.generalMinBaseScore), false);
  });

  it("majorRank ignores personalRelevance", () => {
    const weights = selectConfig.majorRankWeights;
    const lowPr = computeMajorRank(
      scores({ importance: 4, impact: 4, informationValue: 4, personalRelevance: 1 }),
      weights
    );
    const highPr = computeMajorRank(
      scores({ importance: 4, impact: 4, informationValue: 4, personalRelevance: 5 }),
      weights
    );
    assert.equal(lowPr, highPr);
    assert.equal(lowPr, 4);
  });

  it("personalRank uses PR, IV, and novelty", () => {
    const rank = computePersonalRank(
      scores({ personalRelevance: 5, informationValue: 3, novelty: 1 }),
      selectConfig.personalRankWeights
    );
    assert.equal(rank, 3.4);
  });

  it("topicGroup uses title/summary keywords, not provider", () => {
    const nasaPolitics = makeCluster({
      clusterId: "cluster:n1",
      title: "Governor wins election after referendum",
      provider: "nasa-news",
      category: "NASA Headquarters",
    });
    assert.equal(assignTopicGroup(nasaPolitics, selectConfig), "politics");

    const vergeDisaster = makeCluster({
      clusterId: "cluster:v1",
      title: "Record 土石流 kills hundreds in mountain villages",
      provider: "the-verge",
      category: "AI",
    });
    assert.equal(assignTopicGroup(vergeDisaster, selectConfig), "disaster");
  });

  it("keyword matching does not treat provider-like short tokens inside other words", () => {
    assert.equal(keywordMatches("the said announcement", "ai"), false);
    assert.equal(keywordMatches("AI mode buries links", "ai"), true);
  });

  it("selects personal-interest when importance is low but PR and IV are high", async () => {
    const cluster = makeCluster({
      clusterId: "cluster:macs",
      title: "Two new small, powerful Macs for developers",
      scores: {
        importance: 3,
        informationValue: 4,
        impact: 3,
        novelty: 4,
        personalRelevance: 5,
      },
    });
    const result = await runSelectOn([cluster]);
    assert.equal(result.document.selected[0].selectionReason, "personal-interest");
    assert.equal(result.document.selected[0].lane, "personal");
  });

  it("keeps at most 7 major-lane items", async () => {
    const titles = [
      "Kyiv weapons depot strike kills 37",
      "US deal for 65bn barrels of oil",
      "China’s robots race ahead in factories",
      "Opposition leader charged with treason after election",
      "Nepal landslide flood disaster kills hundreds",
      "Manhunt after shooting and extremism cash network",
      "Executive order creates US Space Academy",
      "Genome DNA ecology study finds collapse",
    ];
    const clusters = titles.map((title, index) =>
      makeCluster({
        clusterId: `cluster:m${index}`,
        title,
        publishedAt: `2026-08-30T1${index}:00:00.000Z`,
        scores: {
          importance: 5,
          informationValue: 4,
          impact: 5,
          novelty: 4,
          personalRelevance: 2,
        },
      })
    );
    const result = await runSelectOn(clusters);
    const majors = result.document.selected.filter((entry) => entry.lane === "major");
    assert.equal(majors.length, 7);
    assert.ok(result.document.selected.length <= selectConfig.digestMax);
  });

  it("keeps at most 4 personal-lane items", async () => {
    const titles = [
      "Two new small powerful Macs for developers",
      "Artemis II crew receives space medal",
      "Google further buries search results under AI mode",
      "Night Vale cocreator learned storytelling from Grim Fandango",
      "合気道の審査課題と乱取りの解説",
    ];
    const clusters = titles.map((title, index) =>
      makeCluster({
        clusterId: `cluster:p${index}`,
        title,
        publishedAt: `2026-08-30T1${index}:00:00.000Z`,
        scores: {
          importance: 2,
          informationValue: 3,
          impact: 2,
          novelty: 3,
          personalRelevance: 4,
        },
      })
    );
    const result = await runSelectOn(clusters);
    const personals = result.document.selected.filter((entry) => entry.lane === "personal");
    assert.equal(personals.length, 4);
    assert.equal(result.document.selected.length, 4);
  });

  it("does not pad to target with ineligible items", async () => {
    const clusters = [
      makeCluster({
        clusterId: "cluster:keep",
        title: "Kyiv weapons depot strike",
        scores: {
          importance: 5,
          informationValue: 4,
          impact: 5,
          novelty: 4,
          personalRelevance: 2,
        },
      }),
      makeCluster({
        clusterId: "cluster:ad",
        title: "Buy this mug",
        sourceType: "x",
        scores: {
          importance: 1,
          informationValue: 1,
          impact: 1,
          novelty: 1,
          personalRelevance: 1,
        },
      }),
    ];
    const result = await runSelectOn(clusters);
    assert.equal(result.document.selected.length, 1);
    assert.ok(result.document.selected.length < selectConfig.digestTarget);
  });

  it("allows a third topic item from major", async () => {
    const clusters = [
      makeCluster({
        clusterId: "cluster:d1",
        title: "Nepal flood satellite images show destroyed villages",
        publishedAt: "2026-08-30T10:00:00.000Z",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 3, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d2",
        title: "Fukui landslide 大雨 warning continues overnight",
        publishedAt: "2026-08-30T11:00:00.000Z",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 4, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d3",
        title: "Hurricane typhoon wildfire briefing for coastal towns",
        publishedAt: "2026-08-30T12:00:00.000Z",
        scores: { importance: 4, informationValue: 4, impact: 3, novelty: 4, personalRelevance: 3 },
      }),
    ];
    const result = await runSelectOn(clusters);
    const disasters = result.document.selected.filter((entry) => entry.topicGroup === "disaster");
    assert.equal(disasters.length, 3);
    assert.equal(
      disasters.find((entry) => entry.clusterId === "cluster:d3")?.lane,
      "major"
    );
  });

  it("allows a third topic item from personal", async () => {
    const clusters = [
      makeCluster({
        clusterId: "cluster:d1",
        title: "Nepal flood satellite images show destroyed villages",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 3, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d2",
        title: "Fukui landslide 大雨 warning continues overnight",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 4, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d-personal",
        title: "Hurricane typhoon wildfire briefing for coastal towns",
        scores: { importance: 2, informationValue: 4, impact: 2, novelty: 4, personalRelevance: 5 },
      }),
    ];
    const result = await runSelectOn(clusters);
    const personal = result.document.selected.find(
      (entry) => entry.clusterId === "cluster:d-personal"
    );
    assert.equal(personal?.lane, "personal");
    assert.equal(personal?.topicGroup, "disaster");
    assert.equal(
      result.document.selected.filter((entry) => entry.topicGroup === "disaster").length,
      3
    );
  });

  it("rejects a third topic item from general as category-saturation", async () => {
    const clusters = [
      makeCluster({
        clusterId: "cluster:d1",
        title: "Nepal flood satellite images show destroyed villages",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 3, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d2",
        title: "Fukui landslide 大雨 warning continues overnight",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 4, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d-general",
        title: "Hurricane typhoon wildfire briefing for coastal towns",
        scores: { importance: 3, informationValue: 3, impact: 2, novelty: 4, personalRelevance: 2 },
      }),
    ];
    const result = await runSelectOn(clusters);
    const general = result.document.rejected.find(
      (entry) => entry.clusterId === "cluster:d-general"
    );
    assert.equal(general?.rejectionReason, "category-saturation");
    assert.equal(
      result.document.selected.filter((entry) => entry.topicGroup === "disaster").length,
      2
    );
  });

  it("rejects a fourth topic item from personal as category-saturation", async () => {
    const clusters = [
      makeCluster({
        clusterId: "cluster:d1",
        title: "Nepal flood satellite images show destroyed villages",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 3, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d2",
        title: "Fukui landslide 大雨 warning continues overnight",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 4, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d-personal-3",
        title: "Hurricane typhoon briefing for coastal towns",
        scores: { importance: 2, informationValue: 4, impact: 2, novelty: 4, personalRelevance: 5 },
      }),
      makeCluster({
        clusterId: "cluster:d-personal-4",
        title: "Heatstroke wildfire advisory for inland hikers",
        scores: { importance: 2, informationValue: 3, impact: 2, novelty: 3, personalRelevance: 4 },
      }),
    ];
    const result = await runSelectOn(clusters);
    const third = result.document.selected.find(
      (entry) => entry.clusterId === "cluster:d-personal-3"
    );
    const fourth = result.document.rejected.find(
      (entry) => entry.clusterId === "cluster:d-personal-4"
    );
    assert.equal(third?.lane, "personal");
    assert.equal(fourth?.rejectionReason, "category-saturation");
    assert.equal(
      result.document.selected.filter((entry) => entry.topicGroup === "disaster").length,
      3
    );
  });

  it("rejects a fourth topic item from major unless it is in major top3", async () => {
    const clusters = [
      makeCluster({
        clusterId: "cluster:d1",
        title: "Nepal flood satellite images show destroyed villages",
        publishedAt: "2026-08-30T10:00:00.000Z",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 3, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d2",
        title: "Fukui landslide 大雨 warning continues overnight",
        publishedAt: "2026-08-30T11:00:00.000Z",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 4, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d3",
        title: "Hurricane typhoon briefing for coastal towns",
        publishedAt: "2026-08-30T12:00:00.000Z",
        scores: { importance: 4, informationValue: 4, impact: 3, novelty: 4, personalRelevance: 3 },
      }),
      makeCluster({
        clusterId: "cluster:d4",
        title: "Heatstroke wildfire advisory for inland hikers",
        publishedAt: "2026-08-30T13:00:00.000Z",
        scores: { importance: 4, informationValue: 3, impact: 3, novelty: 3, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:i1",
        title: "Kyiv weapons depot strike kills 37",
        scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
      }),
    ];
    const result = await runSelectOn(clusters);
    const d4 = result.document.rejected.find((entry) => entry.clusterId === "cluster:d4");
    assert.equal(d4?.rejectionReason, "category-saturation");
    assert.equal(
      result.document.selected.filter((entry) => entry.topicGroup === "disaster").length,
      3
    );
  });

  it("protects major top3 from topic saturation", async () => {
    const clusters = [
      makeCluster({
        clusterId: "cluster:top",
        title: "Kyiv weapons depot strike kills 37",
        scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
      }),
      makeCluster({
        clusterId: "cluster:d1",
        title: "Nepal flood satellite images",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 3, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d2",
        title: "Barrier lake Nepal flood risk",
        scores: { importance: 4, informationValue: 4, impact: 4, novelty: 4, personalRelevance: 2 },
      }),
      makeCluster({
        clusterId: "cluster:d3",
        title: "Tibet flood footage suppressed",
        scores: { importance: 4, informationValue: 4, impact: 3, novelty: 4, personalRelevance: 3 },
      }),
      makeCluster({
        clusterId: "cluster:d-top",
        title: "Massive landslide flood disaster kills 700",
        scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
      }),
    ];
    const result = await runSelectOn(clusters);
    const ids = result.document.selected.map((entry) => entry.clusterId);
    assert.ok(ids.includes("cluster:d-top"));
    assert.ok(ids.includes("cluster:top"));
  });

  it("groups semantic related-event pairs and keeps one main-event", async () => {
    const a = makeCluster({
      clusterId: "cluster:artemis",
      itemIds: ["item:a"],
      title: "Artemis II crew receives space medal",
      scores: { importance: 2, informationValue: 3, impact: 2, novelty: 3, personalRelevance: 4 },
    });
    a.representative.itemId = "item:a";
    const b = makeCluster({
      clusterId: "cluster:academy",
      itemIds: ["item:b"],
      title: "Executive order creates US Space Academy",
      scores: { importance: 4, informationValue: 4, impact: 3, novelty: 4, personalRelevance: 5 },
    });
    b.representative.itemId = "item:b";
    const semantic = makeSemantic({
      judgments: [
        {
          itemA: "item:a",
          itemB: "item:b",
          relationship: "related-event",
          status: "ok",
          confidence: 0.9,
        },
      ],
    });
    const result = await runSelectOn([a, b], { semantic });
    assert.equal(result.stats.multiClusterRelatedGroups, 1);
    assert.equal(result.stats.redundantRejected, 1);
    const selectedIds = result.document.selected.map((entry) => entry.clusterId);
    assert.deepEqual(selectedIds, ["cluster:academy"]);
    const related = result.document.rejected.find((entry) => entry.clusterId === "cluster:artemis");
    assert.equal(related.rejectionReason, "redundant");
  });

  it("uses conservative title overlap for distinctive shared phrases", async () => {
    const overlap = titleOverlapEvidence(
      "ネパール土石流 768人死亡 3000人以上不明 6歳女児を救出",
      "ネパール土石流 当時滞在の日本人研究者“出発遅れていたら”",
      selectConfig.titleOverlap
    );
    assert.equal(overlap.matched, true);
    assert.equal(overlap.kind, "title-overlap");

    const falseFriend = titleOverlapEvidence(
      "Norway's new king remembers father in first speech",
      "Spain's new king remembers mother in first speech",
      selectConfig.titleOverlap
    );
    assert.equal(falseFriend.matched, false);

    const boilerplate = titleOverlapEvidence(
      "製作者の意図を汲む人物なら、デスマフィン騒動を踏まえ食品衛生法無視の発言はできないと指摘している。",
      "死後の自分の行動をうさぎの絵で描く創作が、命の整理になっていると述べている。",
      selectConfig.titleOverlap
    );
    assert.equal(boilerplate.matched, false);
  });

  it("does not group unrelated similar titles", async () => {
    const robots = makeCluster({
      clusterId: "cluster:robots",
      title: "China’s robots race ahead",
      scores: { importance: 4, informationValue: 4, impact: 4, novelty: 4, personalRelevance: 5 },
    });
    const opinion = makeCluster({
      clusterId: "cluster:opinion",
      title: "中国だけ見下すような日本社会の曖昧な空気が将来の弱点になると指摘している意見。",
      scores: { importance: 3, informationValue: 2, impact: 3, novelty: 2, personalRelevance: 3 },
    });
    const result = await runSelectOn([robots, opinion]);
    assert.equal(result.stats.multiClusterRelatedGroups, 0);
  });

  it("main-event ordering is deterministic without majorRank", async () => {
    const older = makeCluster({
      clusterId: "cluster:z",
      itemIds: ["item:z"],
      title: "ネパール土石流 older update",
      publishedAt: "2026-08-29T10:00:00.000Z",
      scores: { importance: 3, informationValue: 3, impact: 2, novelty: 3, personalRelevance: 2 },
    });
    older.representative.itemId = "item:z";
    const newer = makeCluster({
      clusterId: "cluster:a",
      itemIds: ["item:a"],
      title: "ネパール土石流 newer update",
      publishedAt: "2026-08-30T10:00:00.000Z",
      scores: { importance: 3, informationValue: 3, impact: 2, novelty: 3, personalRelevance: 2 },
    });
    newer.representative.itemId = "item:a";
    const result = await runSelectOn([older, newer]);
    const group = result.review.groups[0];
    assert.equal(group.selectedMainEvent.clusterId, "cluster:a");
    assert.equal(group.rejectedRelated[0].clusterId, "cluster:z");
  });

  it("partitions every input cluster into selected or rejected once", async () => {
    const clusters = [
      makeCluster({
        clusterId: "cluster:1",
        title: "Kyiv weapons depot strike",
        scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
      }),
      makeCluster({
        clusterId: "cluster:2",
        title: "Buy a novelty mug",
        scores: { importance: 1, informationValue: 1, impact: 1, novelty: 1, personalRelevance: 1 },
      }),
      makeCluster({
        clusterId: "cluster:3",
        title: "Two new Macs for developers",
        scores: { importance: 3, informationValue: 4, impact: 3, novelty: 4, personalRelevance: 5 },
      }),
    ];
    const result = await runSelectOn(clusters);
    assert.equal(result.stats.inputClusters, 3);
    assert.equal(result.document.selected.length + result.document.rejected.length, 3);
    const ids = [
      ...result.document.selected.map((entry) => entry.clusterId),
      ...result.document.rejected.map((entry) => entry.clusterId),
    ];
    assert.equal(new Set(ids).size, 3);
  });

  it("copies scores and does not mutate membership or representative", async () => {
    const cluster = makeCluster({
      clusterId: "cluster:keep",
      itemIds: ["item:keep"],
      title: "Kyiv weapons depot strike",
      scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
    });
    const originalItems = cluster.itemIds.slice();
    const originalTitle = cluster.representative.title;
    const originalScores = { ...cluster.scores };
    const result = await runSelectOn([cluster]);
    assert.deepEqual(cluster.itemIds, originalItems);
    assert.equal(cluster.representative.title, originalTitle);
    assert.deepEqual(cluster.scores, originalScores);
    assert.deepEqual(result.document.selected[0].scores, originalScores);
    assert.equal(result.document.selected[0].baseScore, cluster.baseScore);
    assert.equal(result.document.selected[0].representative.title, originalTitle);
  });

  it("dry-run does not write selected or review files", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "news-selected.json");
    const reviewPath = path.join(dir, "news-selected-review.json");
    const result = await runSelectOn(
      [
        makeCluster({
          clusterId: "cluster:keep",
          title: "Kyiv weapons depot strike",
          scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
        }),
      ],
      { dryRun: true, outputPath, reviewPath }
    );
    assert.equal(result.dryRun, true);
    await assert.rejects(() => readFile(outputPath), { code: "ENOENT" });
    await assert.rejects(() => readFile(reviewPath), { code: "ENOENT" });
  });

  it("writes selected and review atomically when not dry-run", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "out", "news-selected.json");
    const reviewPath = path.join(dir, "out", "news-selected-review.json");
    await runSelectPipeline({
      dryRun: false,
      selectConfig,
      evaluated: makeEvaluated([
        makeCluster({
          clusterId: "cluster:keep",
          title: "Kyiv weapons depot strike",
          scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
        }),
      ]),
      semantic: makeSemantic(),
      outputPath,
      reviewPath,
      now: () => "2026-09-01T10:00:00.000Z",
    });
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.selected.length, 1);
    const leftover = (await readdir(path.dirname(outputPath))).filter((name) =>
      name.endsWith(".tmp")
    );
    assert.deepEqual(leftover, []);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    assert.equal(review.schemaVersion, 1);
  });

  it("fails when evaluated input is missing", async () => {
    const dir = await makeTempDir();
    await assert.rejects(
      () =>
        runSelectPipeline({
          dryRun: true,
          selectConfig,
          evaluatedPath: path.join(dir, "missing-evaluated.json"),
          semantic: makeSemantic(),
        }),
      /missing/
    );
  });

  it("fails when semantic input is missing", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "news-evaluated.json"),
      JSON.stringify(makeEvaluated([makeCluster()]))
    );
    await assert.rejects(
      () =>
        runSelectPipeline({
          dryRun: true,
          selectConfig,
          evaluatedPath: path.join(dir, "news-evaluated.json"),
          semanticPath: path.join(dir, "missing-semantic.json"),
        }),
      /missing/
    );
  });

  it("CLI dry-run reports stats and does not write", async () => {
    const dir = await makeTempDir();
    const outputPath = path.join(dir, "news-selected.json");
    const stdout = collectWriter();
    const code = await runSelect({
      dryRun: true,
      selectConfig,
      evaluated: makeEvaluated([
        makeCluster({
          clusterId: "cluster:keep",
          title: "Kyiv weapons depot strike",
          scores: { importance: 5, informationValue: 4, impact: 5, novelty: 4, personalRelevance: 3 },
        }),
      ]),
      semantic: makeSemantic(),
      outputPath,
      stdout,
    });
    assert.equal(code, 0);
    assert.match(stdout.toString(), /News Select dry-run/);
    assert.match(stdout.toString(), /API calls: 0/);
    await assert.rejects(() => readFile(outputPath), { code: "ENOENT" });
  });

  it("parseSelectArgs only enables dry-run", () => {
    assert.deepEqual(parseSelectArgs(["--dry-run"]), { dryRun: true });
    assert.deepEqual(parseSelectArgs([]), { dryRun: false });
  });

  it("real evaluated document partitions all clusters without writing", async () => {
    const evaluated = JSON.parse(readFileSync(NEWS_EVALUATED_PATH, "utf8"));
    const semantic = JSON.parse(readFileSync(NEWS_SEMANTIC_PATH, "utf8"));
    const result = await runSelectPipeline({
      dryRun: true,
      selectConfig,
      evaluated,
      semantic,
      now: () => "2026-09-01T10:00:00.000Z",
    });
    assert.equal(result.stats.inputClusters, evaluated.clusters.length);
    assert.equal(
      result.document.selected.length + result.document.rejected.length,
      evaluated.clusters.length
    );
    assert.ok(result.document.selected.length <= selectConfig.digestMax);
    const selectedIds = new Set(result.document.selected.map((entry) => entry.clusterId));
    const rejectedIds = new Set(result.document.rejected.map((entry) => entry.clusterId));
    assert.equal(selectedIds.size, result.document.selected.length);
    for (const cluster of evaluated.clusters) {
      const inSelected = selectedIds.has(cluster.clusterId);
      const inRejected = rejectedIds.has(cluster.clusterId);
      assert.equal(inSelected || inRejected, true);
      assert.equal(inSelected && inRejected, false);
      assert.deepEqual(
        cluster.itemIds,
        evaluated.clusters.find((entry) => entry.clusterId === cluster.clusterId).itemIds
      );
    }
  });
});
