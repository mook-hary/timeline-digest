import fs from "node:fs/promises";
import { ValidationError } from "../lib/errors.js";
import {
  DEFAULT_EVALUATION_WEIGHTS,
  EVALUATION_SCORE_AXES,
} from "../lib/evaluation-score.js";

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

export function validateEvaluationConfig(data) {
  if (!isPlainObject(data)) {
    throw new ValidationError("Evaluation config must be an object");
  }
  if (data.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported evaluation config schemaVersion: ${data.schemaVersion}`
    );
  }
  if (!isPlainObject(data.weights)) {
    throw new ValidationError("evaluation config weights must be an object");
  }
  if (!isPlainObject(data.openai)) {
    throw new ValidationError("evaluation config openai must be an object");
  }

  const weights = {};
  for (const axis of EVALUATION_SCORE_AXES) {
    weights[axis] = requireNumber(data.weights[axis], `weights.${axis}`, {
      min: 0,
      max: 1,
    });
  }

  const sum = EVALUATION_SCORE_AXES.reduce((total, axis) => total + weights[axis], 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new ValidationError(`evaluation config weights must sum to 1.0 (got ${sum})`);
  }

  return {
    schemaVersion: 1,
    evaluatorVersion: requireString(data.evaluatorVersion, "evaluatorVersion"),
    provider: requireString(data.provider, "provider"),
    model: requireString(data.model, "model"),
    maxItemsPerCluster: requireInteger(
      data.maxItemsPerCluster,
      "maxItemsPerCluster",
      { min: 1 }
    ),
    summaryClipChars: requireInteger(data.summaryClipChars, "summaryClipChars", {
      min: 1,
    }),
    weights,
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

export function resolveEvaluationModel(config, env = process.env) {
  const evaluationModel = env.EVALUATION_MODEL && String(env.EVALUATION_MODEL).trim();
  if (evaluationModel) return evaluationModel;
  const openaiModel = env.OPENAI_MODEL && String(env.OPENAI_MODEL).trim();
  if (openaiModel) return openaiModel;
  return config.model;
}

export async function loadEvaluationConfig(filePath, env = process.env) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ValidationError(
      `Failed to read evaluation config: ${error.message}`,
      { cause: error }
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("Evaluation config is not valid JSON", {
      cause: error,
    });
  }

  const config = validateEvaluationConfig(data);
  return {
    ...config,
    model: resolveEvaluationModel(config, env),
  };
}

export { DEFAULT_EVALUATION_WEIGHTS };
