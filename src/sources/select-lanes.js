import { hasCompleteScores } from "./select-eligibility.js";

export function roundSelectScore(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

export function computeMajorRank(scores, weights) {
  if (!hasCompleteScores(scores) || weights == null) return null;
  return roundSelectScore(
    weights.importance * scores.importance +
      weights.impact * scores.impact +
      weights.informationValue * scores.informationValue
  );
}

export function computePersonalRank(scores, weights) {
  if (!hasCompleteScores(scores) || weights == null) return null;
  return roundSelectScore(
    weights.personalRelevance * scores.personalRelevance +
      weights.informationValue * scores.informationValue +
      weights.novelty * scores.novelty
  );
}

export function passesMajorGate(scores, majorGate) {
  return (
    hasCompleteScores(scores) &&
    scores.importance >= majorGate.minImportance &&
    scores.impact >= majorGate.minImpact
  );
}

export function passesPersonalGate(scores, personalGate) {
  return (
    hasCompleteScores(scores) &&
    scores.personalRelevance >= personalGate.minPersonalRelevance &&
    scores.informationValue >= personalGate.minInformationValue
  );
}

export function passesGeneralGate(baseScore, minBaseScore) {
  return typeof baseScore === "number" && Number.isFinite(baseScore) && baseScore >= minBaseScore;
}

export function tagLanes(record, config) {
  const scores = record.cluster.scores;
  record.majorRank = computeMajorRank(scores, config.majorRankWeights);
  record.personalRank = computePersonalRank(scores, config.personalRankWeights);
  record.passesMajor = record.eligible && passesMajorGate(scores, config.majorGate);
  record.passesPersonal = record.eligible && passesPersonalGate(scores, config.personalGate);
  record.passesGeneral =
    record.eligible && passesGeneralGate(record.cluster.baseScore, config.generalMinBaseScore);
  const lanes = [];
  if (record.passesMajor) lanes.push("major");
  if (record.passesPersonal) lanes.push("personal");
  if (record.passesGeneral) lanes.push("general");
  record.lanes = lanes;
  record.lane = lanes[0] || null;
}
