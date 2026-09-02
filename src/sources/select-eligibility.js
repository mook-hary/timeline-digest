import { EVALUATION_SCORE_AXES } from "../lib/evaluation-score.js";

function isScoreInteger(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

export function hasCompleteScores(scores) {
  if (scores == null || typeof scores !== "object" || Array.isArray(scores)) {
    return false;
  }
  return EVALUATION_SCORE_AXES.every((axis) => isScoreInteger(scores[axis]));
}

export function isEvaluatedCluster(cluster) {
  return cluster != null && cluster.status === "evaluated" && hasCompleteScores(cluster.scores);
}

export function failsQualityFloor(scores, qualityFloor) {
  if (!hasCompleteScores(scores)) return true;
  if (scores.informationValue <= qualityFloor.maxInformationValueAlone) return true;
  return (
    scores.importance <= qualityFloor.lowImportance &&
    scores.impact <= qualityFloor.lowImpact &&
    scores.informationValue <= qualityFloor.lowInformationValue
  );
}

export function eligibilityOf(cluster, qualityFloor) {
  if (!isEvaluatedCluster(cluster)) {
    return { eligible: false, reason: "not-evaluated" };
  }
  if (failsQualityFloor(cluster.scores, qualityFloor)) {
    return { eligible: false, reason: "below-quality-floor" };
  }
  return { eligible: true, reason: null };
}
