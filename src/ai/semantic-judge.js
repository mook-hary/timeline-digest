import { SEMANTIC_RELATIONSHIPS } from "../sources/semantic-config.js";

export function validateSemanticJudgment(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: "failed",
      error: "invalid-json",
      relationship: null,
      confidence: null,
      reason: null,
    };
  }

  if (!SEMANTIC_RELATIONSHIPS.includes(raw.relationship)) {
    return {
      status: "failed",
      error: "invalid-relationship",
      relationship: null,
      confidence: null,
      reason: null,
    };
  }

  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) {
    return {
      status: "failed",
      error: "invalid-confidence",
      relationship: null,
      confidence: null,
      reason: null,
    };
  }
  if (raw.confidence < 0 || raw.confidence > 1) {
    return {
      status: "failed",
      error: "invalid-confidence",
      relationship: null,
      confidence: null,
      reason: null,
    };
  }

  if (typeof raw.reason !== "string") {
    return {
      status: "failed",
      error: "invalid-reason",
      relationship: null,
      confidence: null,
      reason: null,
    };
  }

  return {
    status: "ok",
    relationship: raw.relationship,
    confidence: raw.confidence,
    reason: raw.reason.trim().slice(0, 300),
    error: null,
  };
}

export function failedJudgment(error) {
  const diagnostic = error && error.diagnostic ? error.diagnostic : null;
  const message =
    error && error.message ? String(error.message).split("\n")[0] : String(error);
  return {
    status: "failed",
    error: redactSecrets(message).slice(0, 300),
    errorDetail: diagnostic,
    relationship: null,
    confidence: null,
    reason: null,
  };
}

export function redactSecrets(text) {
  return String(text)
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/Authorization:\s*\S+/gi, "Authorization: [redacted]");
}

export async function judgeSemanticPair(itemA, itemB, context, judge) {
  try {
    const raw = await judge({ itemA, itemB, context });
    return validateSemanticJudgment(raw);
  } catch (error) {
    return failedJudgment(error);
  }
}
