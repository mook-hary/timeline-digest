import {
  EVALUATION_SCORE_AXES,
  emptyEvaluationScores,
} from "../lib/evaluation-score.js";
import { redactSecrets } from "./semantic-judge.js";

function failed(error, extra = {}) {
  return {
    status: "failed",
    error,
    errorDetail: extra.errorDetail || null,
    scores: emptyEvaluationScores(),
    reason: null,
  };
}

export function validateEvaluationJudgment(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return failed("invalid-json");
  }
  if (raw.scores == null || typeof raw.scores !== "object" || Array.isArray(raw.scores)) {
    return failed("invalid-scores");
  }
  if (typeof raw.reason !== "string") {
    return failed("invalid-reason");
  }

  const scores = {};
  for (const axis of EVALUATION_SCORE_AXES) {
    if (!Object.hasOwn(raw.scores, axis)) {
      return failed("missing-axis");
    }
    const value = raw.scores[axis];
    if (!Number.isInteger(value)) {
      return failed("invalid-score");
    }
    if (value < 1 || value > 5) {
      return failed("invalid-score");
    }
    scores[axis] = value;
  }

  return {
    status: "ok",
    error: null,
    errorDetail: null,
    scores,
    reason: raw.reason.trim().slice(0, 300),
  };
}

export function failedEvaluation(error) {
  const diagnostic = error && error.diagnostic ? error.diagnostic : null;
  const message =
    error && error.message ? String(error.message).split("\n")[0] : String(error);
  return failed(redactSecrets(message).slice(0, 300), { errorDetail: diagnostic });
}

export async function evaluateClusterJudgment(payload, evaluator) {
  try {
    const raw = await evaluator(payload);
    return validateEvaluationJudgment(raw);
  } catch (error) {
    return failedEvaluation(error);
  }
}
