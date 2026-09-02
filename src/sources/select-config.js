import fs from "node:fs/promises";
import { ValidationError } from "../lib/errors.js";

export const SELECT_TOPIC_GROUPS = [
  "politics",
  "international",
  "economy",
  "ai_tech",
  "science",
  "space",
  "disaster",
  "creative",
  "aikido",
  "social",
  "other",
];

export const SELECT_SELECTION_REASONS = [
  "major-news",
  "personal-interest",
  "general-high-value",
];

export const SELECT_REJECTION_REASONS = [
  "not-evaluated",
  "below-quality-floor",
  "redundant",
  "category-saturation",
  "lower-priority",
  "digest-size",
  "below-lane-threshold",
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

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty array`);
  }
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function requireWeightMap(value, keys, label) {
  if (!isPlainObject(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  const weights = {};
  let sum = 0;
  for (const key of keys) {
    weights[key] = requireNumber(value[key], `${label}.${key}`, { min: 0, max: 1 });
    sum += weights[key];
  }
  if (Math.abs(sum - 1) > 1e-9) {
    throw new ValidationError(`${label} must sum to 1.0 (got ${sum})`);
  }
  return weights;
}

export function validateSelectConfig(data) {
  if (!isPlainObject(data)) {
    throw new ValidationError("Select config must be an object");
  }
  if (data.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported select config schemaVersion: ${data.schemaVersion}`
    );
  }
  if (!isPlainObject(data.qualityFloor)) {
    throw new ValidationError("select config qualityFloor must be an object");
  }
  if (!isPlainObject(data.majorGate)) {
    throw new ValidationError("select config majorGate must be an object");
  }
  if (!isPlainObject(data.personalGate)) {
    throw new ValidationError("select config personalGate must be an object");
  }
  if (!isPlainObject(data.titleOverlap)) {
    throw new ValidationError("select config titleOverlap must be an object");
  }
  if (!isPlainObject(data.topicKeywords)) {
    throw new ValidationError("select config topicKeywords must be an object");
  }
  if (!isPlainObject(data.categoryFallback)) {
    throw new ValidationError("select config categoryFallback must be an object");
  }

  const topicPriority = requireStringArray(data.topicPriority, "topicPriority");
  for (const group of topicPriority) {
    if (!SELECT_TOPIC_GROUPS.includes(group)) {
      throw new ValidationError(`unknown topicPriority group: ${group}`);
    }
  }

  const topicKeywords = {};
  for (const group of SELECT_TOPIC_GROUPS) {
    if (group === "other") continue;
    topicKeywords[group] = requireStringArray(
      data.topicKeywords[group],
      `topicKeywords.${group}`
    );
  }

  const categoryFallback = {};
  for (const [category, group] of Object.entries(data.categoryFallback)) {
    const mapped = requireString(group, `categoryFallback.${category}`);
    if (!SELECT_TOPIC_GROUPS.includes(mapped)) {
      throw new ValidationError(
        `categoryFallback.${category} maps to unknown group: ${mapped}`
      );
    }
    categoryFallback[category] = mapped;
  }

  const digestTarget = requireInteger(data.digestTarget, "digestTarget", { min: 1 });
  const digestMax = requireInteger(data.digestMax, "digestMax", { min: 1 });
  if (digestMax < digestTarget) {
    throw new ValidationError("digestMax must be >= digestTarget");
  }

  return {
    schemaVersion: 1,
    policyId: requireString(data.policyId, "policyId"),
    digestTarget,
    digestMax,
    majorCap: requireInteger(data.majorCap, "majorCap", { min: 1 }),
    personalCap: requireInteger(data.personalCap, "personalCap", { min: 1 }),
    majorTopProtect: requireInteger(data.majorTopProtect, "majorTopProtect", {
      min: 1,
    }),
    topicSoftMax: requireInteger(data.topicSoftMax, "topicSoftMax", { min: 1 }),
    topicFreeMax: requireInteger(data.topicFreeMax, "topicFreeMax", { min: 0 }),
    generalMinBaseScore: requireNumber(
      data.generalMinBaseScore,
      "generalMinBaseScore",
      { min: 0, max: 5 }
    ),
    qualityFloor: {
      maxInformationValueAlone: requireInteger(
        data.qualityFloor.maxInformationValueAlone,
        "qualityFloor.maxInformationValueAlone",
        { min: 1 }
      ),
      lowImportance: requireInteger(
        data.qualityFloor.lowImportance,
        "qualityFloor.lowImportance",
        { min: 1 }
      ),
      lowImpact: requireInteger(
        data.qualityFloor.lowImpact,
        "qualityFloor.lowImpact",
        { min: 1 }
      ),
      lowInformationValue: requireInteger(
        data.qualityFloor.lowInformationValue,
        "qualityFloor.lowInformationValue",
        { min: 1 }
      ),
    },
    majorGate: {
      minImportance: requireInteger(
        data.majorGate.minImportance,
        "majorGate.minImportance",
        { min: 1 }
      ),
      minImpact: requireInteger(
        data.majorGate.minImpact,
        "majorGate.minImpact",
        { min: 1 }
      ),
    },
    personalGate: {
      minPersonalRelevance: requireInteger(
        data.personalGate.minPersonalRelevance,
        "personalGate.minPersonalRelevance",
        { min: 1 }
      ),
      minInformationValue: requireInteger(
        data.personalGate.minInformationValue,
        "personalGate.minInformationValue",
        { min: 1 }
      ),
    },
    majorRankWeights: requireWeightMap(
      data.majorRankWeights,
      ["importance", "impact", "informationValue"],
      "majorRankWeights"
    ),
    personalRankWeights: requireWeightMap(
      data.personalRankWeights,
      ["personalRelevance", "informationValue", "novelty"],
      "personalRankWeights"
    ),
    titleOverlap: {
      minDice: requireNumber(data.titleOverlap.minDice, "titleOverlap.minDice", {
        min: 0,
        max: 1,
      }),
      minTitleLength: requireInteger(
        data.titleOverlap.minTitleLength,
        "titleOverlap.minTitleLength",
        { min: 1 }
      ),
      minSharedProperNouns: requireInteger(
        data.titleOverlap.minSharedProperNouns,
        "titleOverlap.minSharedProperNouns",
        { min: 1 }
      ),
      minSharedCjkRun: requireInteger(
        data.titleOverlap.minSharedCjkRun,
        "titleOverlap.minSharedCjkRun",
        { min: 2 }
      ),
      minLongSharedTermLength: requireInteger(
        data.titleOverlap.minLongSharedTermLength,
        "titleOverlap.minLongSharedTermLength",
        { min: 3 }
      ),
      minSharedTermsWithLong: requireInteger(
        data.titleOverlap.minSharedTermsWithLong,
        "titleOverlap.minSharedTermsWithLong",
        { min: 1 }
      ),
    },
    topicPriority,
    topicKeywords,
    categoryFallback,
  };
}

export async function loadSelectConfig(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ValidationError(`Failed to read select config: ${error.message}`, {
      cause: error,
    });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("Select config is not valid JSON", { cause: error });
  }

  return validateSelectConfig(data);
}
