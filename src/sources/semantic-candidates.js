import { roundScore, titleSimilarity } from "../lib/compare-title.js";
import { timestampMsOrNull } from "./news-pool.js";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "from",
  "with",
  "by",
  "at",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "has",
  "have",
  "had",
  "this",
  "that",
  "it",
  "its",
  "about",
  "after",
  "over",
  "into",
  "than",
  "then",
  "us",
  "uk",
  "new",
  "news",
  "says",
  "said",
  "の",
  "を",
  "が",
  "は",
  "に",
  "で",
  "と",
  "も",
  "へ",
  "や",
]);

function pairIds(left, right) {
  return left < right ? [left, right] : [right, left];
}

export function publishedHoursApart(left, right) {
  const leftMs = timestampMsOrNull(left && left.publishedAt);
  const rightMs = timestampMsOrNull(right && right.publishedAt);
  if (leftMs == null || rightMs == null) return null;
  return Math.abs(leftMs - rightMs) / 3_600_000;
}

export function hostnameOf(url) {
  if (url == null || String(url).trim() === "") return null;
  try {
    return new URL(String(url)).hostname.replace(/\.$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function tokenizeWords(title) {
  if (title == null) return [];
  return String(title)
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token && !STOPWORDS.has(token));
}

export function extractProperNouns(title) {
  if (title == null) return [];
  const original = String(title);
  const latin = original.match(/\b[A-Z][A-Za-z0-9]{2,}\b/g) || [];
  const katakana = original.match(/[ァ-ヶー]{3,}/g) || [];
  return [...new Set([...latin, ...katakana].map((term) => term.toLowerCase()))].sort();
}

function cjkBigrams(title) {
  const chars = String(title || "").match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  if (!chars || chars.length < 2) return [];
  const grams = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.push(`${chars[index]}${chars[index + 1]}`);
  }
  return grams;
}

export function extractTerms(title) {
  const words = tokenizeWords(title).filter((token) => {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) {
      return token.length >= 2;
    }
    return token.length >= 3;
  });
  const terms = new Set([...words, ...cjkBigrams(title), ...extractProperNouns(title)]);
  return [...terms].sort();
}

function jaccard(left, right) {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let overlap = 0;
  for (const value of left) {
    if (rightSet.has(value)) overlap += 1;
  }
  return overlap / new Set([...left, ...right]).size;
}

function shared(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function timeScore(hoursApart, maxHours) {
  if (hoursApart == null) return 0.5;
  if (maxHours <= 0) return 1;
  return Math.max(0, 1 - hoursApart / maxHours);
}

export function scoreCandidatePair(left, right, candidateConfig) {
  const similarity = titleSimilarity(left.title, right.title, {
    nGramSize: candidateConfig.nGramSize,
    minLength: candidateConfig.minTitleLength,
  });
  const leftTerms = extractTerms(left.title);
  const rightTerms = extractTerms(right.title);
  const leftProper = extractProperNouns(left.title);
  const rightProper = extractProperNouns(right.title);
  const sharedTerms = shared(leftTerms, rightTerms);
  const sharedProperNouns = shared(leftProper, rightProper);
  const tokenOverlap = roundScore(jaccard(leftTerms, rightTerms));
  const hoursApart = publishedHoursApart(left, right);
  const leftHost = hostnameOf(left.source && left.source.url);
  const rightHost = hostnameOf(right.source && right.source.url);
  const sameCategory = Boolean(
    left.category && right.category && left.category === right.category
  );
  const differentProvider = left.source.provider !== right.source.provider;

  const dice = similarity.score || 0;
  let score =
    0.5 * dice +
    0.2 * tokenOverlap +
    0.2 * Math.min(1, sharedProperNouns.length / 2) +
    0.05 * timeScore(hoursApart, candidateConfig.maxPublishedHoursApart) +
    0.05 * (sameCategory ? 1 : 0);
  if (differentProvider) score += 0.05;
  score = roundScore(Math.min(1, score));

  return {
    titleSimilarity: similarity.comparable ? similarity.score : null,
    titleExact: similarity.exact,
    tokenOverlap,
    sharedTerms,
    sharedProperNouns,
    hoursApart: hoursApart == null ? null : roundScore(hoursApart),
    sameHostname: Boolean(leftHost && rightHost && leftHost === rightHost),
    sameCategory,
    differentProvider,
    candidateScore: score,
  };
}

function passesTimeWindow(hoursApart, maxHours) {
  if (hoursApart == null) return true;
  return hoursApart <= maxHours;
}

export function isSemanticCandidate(signals, candidateConfig) {
  const dice = signals.titleSimilarity;
  const sharedProper = signals.sharedProperNouns.length;
  if (dice != null && dice >= candidateConfig.minTitleSimilarity) return true;
  if (signals.tokenOverlap >= candidateConfig.minTokenOverlap && sharedProper >= 1) {
    return true;
  }
  if (sharedProper >= candidateConfig.minSharedProperNouns) return true;
  return false;
}

function compareCandidates(a, b) {
  if (b.candidateScore !== a.candidateScore) return b.candidateScore - a.candidateScore;
  if (a.itemA < b.itemA) return -1;
  if (a.itemA > b.itemA) return 1;
  if (a.itemB < b.itemB) return -1;
  if (a.itemB > b.itemB) return 1;
  return 0;
}

export function generateSemanticCandidates(items, candidateConfig) {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const gated = [];

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const left = sorted[i];
      const right = sorted[j];
      const signals = scoreCandidatePair(left, right, candidateConfig);
      if (!passesTimeWindow(signals.hoursApart, candidateConfig.maxPublishedHoursApart)) {
        continue;
      }
      if (!isSemanticCandidate(signals, candidateConfig)) continue;
      const [itemA, itemB] = pairIds(left.id, right.id);
      gated.push({
        itemA,
        itemB,
        candidateScore: signals.candidateScore,
        titleSimilarity: signals.titleSimilarity,
        tokenOverlap: signals.tokenOverlap,
        sharedTerms: signals.sharedTerms,
        sharedProperNouns: signals.sharedProperNouns,
        hoursApart: signals.hoursApart,
        sameHostname: signals.sameHostname,
        sameCategory: signals.sameCategory,
        differentProvider: signals.differentProvider,
        providerA: itemA === left.id ? left.source.provider : right.source.provider,
        providerB: itemA === left.id ? right.source.provider : left.source.provider,
        titleA: itemA === left.id ? left.title : right.title,
        titleB: itemA === left.id ? right.title : left.title,
      });
    }
  }

  gated.sort(compareCandidates);

  const used = new Map();
  const selected = [];
  for (const candidate of gated) {
    if (selected.length >= candidateConfig.maxTotalCandidates) break;
    const usedA = used.get(candidate.itemA) || 0;
    const usedB = used.get(candidate.itemB) || 0;
    if (usedA >= candidateConfig.maxCandidatesPerItem) continue;
    if (usedB >= candidateConfig.maxCandidatesPerItem) continue;
    selected.push(candidate);
    used.set(candidate.itemA, usedA + 1);
    used.set(candidate.itemB, usedB + 1);
  }

  return selected;
}
