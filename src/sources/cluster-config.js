import fs from "node:fs/promises";
import { ValidationError } from "../lib/errors.js";

export const RELATIONSHIP_TYPES = [
  "same-url",
  "same-title",
  "title-similarity",
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

export function validateClusterConfig(data) {
  if (!isPlainObject(data)) {
    throw new ValidationError("Cluster config must be an object");
  }
  if (data.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported cluster config schemaVersion: ${data.schemaVersion}`
    );
  }
  if (!isPlainObject(data.url) || !Array.isArray(data.url.trackingParams)) {
    throw new ValidationError("cluster config url.trackingParams must be an array");
  }
  const trackingParams = data.url.trackingParams.map((param, index) => {
    if (typeof param !== "string" || param.trim() === "") {
      throw new ValidationError(
        `url.trackingParams[${index}] must be a non-empty string`
      );
    }
    return param.trim().toLowerCase();
  });

  if (!isPlainObject(data.title)) {
    throw new ValidationError("cluster config title must be an object");
  }
  if (!isPlainObject(data.confidence)) {
    throw new ValidationError("cluster config confidence must be an object");
  }

  return {
    schemaVersion: 1,
    url: {
      trackingParams,
    },
    title: {
      nGramSize: requireInteger(data.title.nGramSize, "title.nGramSize", {
        min: 2,
      }),
      similarityThreshold: requireNumber(
        data.title.similarityThreshold,
        "title.similarityThreshold",
        { min: 0, max: 1 }
      ),
      minLength: requireInteger(data.title.minLength, "title.minLength", {
        min: 1,
      }),
      sameTitleMinLength: requireInteger(
        data.title.sameTitleMinLength,
        "title.sameTitleMinLength",
        { min: 1 }
      ),
    },
    confidence: {
      sameUrl: requireNumber(data.confidence.sameUrl, "confidence.sameUrl", {
        min: 0,
        max: 1,
      }),
      sameTitle: requireNumber(
        data.confidence.sameTitle,
        "confidence.sameTitle",
        { min: 0, max: 1 }
      ),
    },
  };
}

export async function loadClusterConfig(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ValidationError(
      `Failed to read cluster config: ${error.message}`,
      { cause: error }
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("Cluster config is not valid JSON", {
      cause: error,
    });
  }

  return validateClusterConfig(data);
}
