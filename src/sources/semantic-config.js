import fs from "node:fs/promises";
import { ValidationError } from "../lib/errors.js";

export const SEMANTIC_RELATIONSHIPS = [
  "same-event",
  "related-event",
  "different-event",
];

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requireNumber(value, label, { min, max } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  if (min != null && value < min) {
    throw new ValidationError(`${label} must be >= ${min}`);
  }
  if (max != null && value > max) {
    throw new ValidationError(`${label} must be <= ${max}`);
  }
  return value;
}

function requireInteger(value, label, { min } = {}) {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${label} must be an integer`);
  }
  return requireNumber(value, label, { min });
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function validateSemanticConfig(data) {
  if (!isPlainObject(data)) {
    throw new ValidationError("Semantic config must be an object");
  }
  if (data.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported semantic config schemaVersion: ${data.schemaVersion}`
    );
  }
  if (!isPlainObject(data.candidate)) {
    throw new ValidationError("semantic config candidate must be an object");
  }
  if (!isPlainObject(data.openai)) {
    throw new ValidationError("semantic config openai must be an object");
  }

  return {
    schemaVersion: 1,
    judgeVersion: requireString(data.judgeVersion, "judgeVersion"),
    provider: requireString(data.provider, "provider"),
    model: requireString(data.model, "model"),
    candidate: {
      minTitleSimilarity: requireNumber(
        data.candidate.minTitleSimilarity,
        "candidate.minTitleSimilarity",
        { min: 0, max: 1 }
      ),
      minTokenOverlap: requireNumber(
        data.candidate.minTokenOverlap,
        "candidate.minTokenOverlap",
        { min: 0, max: 1 }
      ),
      minSharedProperNouns: requireInteger(
        data.candidate.minSharedProperNouns,
        "candidate.minSharedProperNouns",
        { min: 1 }
      ),
      maxCandidatesPerItem: requireInteger(
        data.candidate.maxCandidatesPerItem,
        "candidate.maxCandidatesPerItem",
        { min: 1 }
      ),
      maxTotalCandidates: requireInteger(
        data.candidate.maxTotalCandidates,
        "candidate.maxTotalCandidates",
        { min: 1 }
      ),
      maxPublishedHoursApart: requireNumber(
        data.candidate.maxPublishedHoursApart,
        "candidate.maxPublishedHoursApart",
        { min: 0 }
      ),
      nGramSize: requireInteger(data.candidate.nGramSize, "candidate.nGramSize", {
        min: 2,
      }),
      minTitleLength: requireInteger(
        data.candidate.minTitleLength,
        "candidate.minTitleLength",
        { min: 1 }
      ),
    },
    openai: {
      timeoutMs: requireInteger(data.openai.timeoutMs, "openai.timeoutMs", {
        min: 1,
      }),
      maxRetries: requireInteger(data.openai.maxRetries, "openai.maxRetries", {
        min: 0,
      }),
    },
  };
}

export function resolveSemanticModel(config, env = process.env) {
  const semanticModel = env.SEMANTIC_MODEL && String(env.SEMANTIC_MODEL).trim();
  if (semanticModel) return semanticModel;
  const openaiModel = env.OPENAI_MODEL && String(env.OPENAI_MODEL).trim();
  if (openaiModel) return openaiModel;
  return config.model;
}

export async function loadSemanticConfig(filePath, env = process.env) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ValidationError(
      `Failed to read semantic config: ${error.message}`,
      { cause: error }
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("Semantic config is not valid JSON", {
      cause: error,
    });
  }

  const config = validateSemanticConfig(data);
  return {
    ...config,
    model: resolveSemanticModel(config, env),
  };
}
