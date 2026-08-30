export const EVALUATION_SCORE_AXES = [
  "importance",
  "informationValue",
  "impact",
  "novelty",
  "personalRelevance",
];

export const DEFAULT_EVALUATION_WEIGHTS = {
  importance: 0.3,
  informationValue: 0.25,
  impact: 0.2,
  novelty: 0.15,
  personalRelevance: 0.1,
};

export function emptyEvaluationScores() {
  return {
    importance: null,
    informationValue: null,
    impact: null,
    novelty: null,
    personalRelevance: null,
  };
}

function isScoreInteger(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

export function computeBaseScore(scores, weights = DEFAULT_EVALUATION_WEIGHTS) {
  if (scores == null || typeof scores !== "object" || Array.isArray(scores)) {
    return null;
  }
  if (weights == null || typeof weights !== "object") return null;

  let total = 0;
  for (const axis of EVALUATION_SCORE_AXES) {
    const value = scores[axis];
    if (!isScoreInteger(value)) return null;
    const weight = weights[axis];
    if (typeof weight !== "number" || !Number.isFinite(weight)) return null;
    total += value * weight;
  }
  return Math.round(total * 10000) / 10000;
}
