import { SELECT_TOPIC_GROUPS } from "./select-config.js";

function normalizeText(value) {
  if (value == null) return "";
  return String(value).normalize("NFKC").toLowerCase();
}

export function keywordMatches(text, keyword) {
  const haystack = normalizeText(text);
  const needle = normalizeText(keyword);
  if (!haystack || !needle) return false;
  if (/[^\p{L}\p{N}]/u.test(needle) || needle.length >= 4 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(needle)) {
    return haystack.includes(needle);
  }
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
    "u"
  );
  return pattern.test(haystack);
}

export function countKeywordHits(text, keywords) {
  let hits = 0;
  for (const keyword of keywords || []) {
    if (keywordMatches(text, keyword)) hits += 1;
  }
  return hits;
}

export function assignTopicGroup(cluster, config) {
  const title = cluster.representative?.title ?? "";
  const summary = cluster.representative?.summary ?? "";
  const text = `${title}\n${summary}`;
  let bestGroup = null;
  let bestHits = 0;

  for (const group of config.topicPriority) {
    if (group === "other") continue;
    const hits = countKeywordHits(text, config.topicKeywords[group]);
    if (hits > bestHits) {
      bestHits = hits;
      bestGroup = group;
    }
  }

  if (bestGroup && bestHits > 0) return bestGroup;

  const category = cluster.representative?.category;
  if (typeof category === "string" && config.categoryFallback[category]) {
    return config.categoryFallback[category];
  }
  return "other";
}

export function assertKnownTopicGroup(group) {
  if (!SELECT_TOPIC_GROUPS.includes(group)) {
    return "other";
  }
  return group;
}
