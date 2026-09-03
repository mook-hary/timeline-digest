import fs from "node:fs/promises";
import { ValidationError } from "../lib/errors.js";

export const DIGEST_STATUSES = ["ok", "fallback", "failed", "ungenerated"];

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

export function validateDigestConfig(data) {
  if (!isPlainObject(data)) {
    throw new ValidationError("Digest config must be an object");
  }
  if (data.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported digest config schemaVersion: ${data.schemaVersion}`
    );
  }
  if (!isPlainObject(data.openai)) {
    throw new ValidationError("digest config openai must be an object");
  }

  const headlineMinChars = requireInteger(
    data.headlineMinChars,
    "headlineMinChars",
    { min: 1 }
  );
  const headlineMaxChars = requireInteger(
    data.headlineMaxChars,
    "headlineMaxChars",
    { min: 1 }
  );
  if (headlineMaxChars < headlineMinChars) {
    throw new ValidationError("headlineMaxChars must be >= headlineMinChars");
  }

  return {
    schemaVersion: 1,
    generatorVersion: requireString(data.generatorVersion, "generatorVersion"),
    provider: requireString(data.provider, "provider"),
    model: requireString(data.model, "model"),
    maxSupportingItems: requireInteger(
      data.maxSupportingItems,
      "maxSupportingItems",
      { min: 0 }
    ),
    summaryClipChars: requireInteger(data.summaryClipChars, "summaryClipChars", {
      min: 1,
    }),
    headlineMinChars,
    headlineMaxChars,
    summaryMaxChars: requireInteger(data.summaryMaxChars, "summaryMaxChars", {
      min: 1,
    }),
    whyItMattersMaxChars: requireInteger(
      data.whyItMattersMaxChars,
      "whyItMattersMaxChars",
      { min: 1 }
    ),
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

export function resolveDigestModel(config, env = process.env) {
  const digestModel = env.DIGEST_MODEL && String(env.DIGEST_MODEL).trim();
  if (digestModel) return digestModel;
  const openaiModel = env.OPENAI_MODEL && String(env.OPENAI_MODEL).trim();
  if (openaiModel) return openaiModel;
  return config.model;
}

export async function loadDigestConfig(filePath, env = process.env) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ValidationError(`Failed to read digest config: ${error.message}`, {
      cause: error,
    });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("Digest config is not valid JSON", { cause: error });
  }

  const config = validateDigestConfig(data);
  return {
    ...config,
    model: resolveDigestModel(config, env),
  };
}
