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
    weights,
  };
}

export async function loadEvaluationConfig(filePath) {
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

  return validateEvaluationConfig(data);
}

export { DEFAULT_EVALUATION_WEIGHTS };
