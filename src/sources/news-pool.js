import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "../config.js";
import { writeJsonAtomic } from "../lib/atomic-write.js";
import { ValidationError } from "../lib/errors.js";
import {
  loadUnifyInputs,
  validateUnifyInputsConfig,
} from "./unify-inputs.js";

export const NORMALIZED_SCHEMA_VERSION = 1;

const REQUIRED_TOP_LEVEL = [
  "schemaVersion",
  "generatedAt",
  "sourceFeeds",
  "items",
];

const REQUIRED_ITEM_KEYS = [
  "id",
  "source",
  "title",
  "summary",
  "category",
  "publishedAt",
  "collectedAt",
  "scores",
];

const REQUIRED_SOURCE_KEYS = ["type", "provider", "url", "originalId", "author"];

const NULLABLE_STRING_KEYS = [
  "title",
  "summary",
  "category",
  "publishedAt",
  "collectedAt",
];

const SCORE_KEYS = [
  "informationValue",
  "personalRelevance",
  "impact",
  "attentionSignal",
  "importance",
];

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function inputLabel(input) {
  return `input "${input.id}" (${input.path})`;
}

export function validateNormalizedDocument(document, label) {
  if (!isPlainObject(document)) {
    throw new ValidationError(`${label} must be an object`);
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!Object.hasOwn(document, key)) {
      throw new ValidationError(`${label} missing field: ${key}`);
    }
  }

  if (document.schemaVersion !== NORMALIZED_SCHEMA_VERSION) {
    throw new ValidationError(
      `${label} unsupported schemaVersion: ${document.schemaVersion}`
    );
  }

  if (!nonemptyString(document.generatedAt)) {
    throw new ValidationError(`${label} generatedAt must be a non-empty string`);
  }

  if (!Array.isArray(document.sourceFeeds)) {
    throw new ValidationError(`${label} sourceFeeds must be an array`);
  }

  if (!Array.isArray(document.items)) {
    throw new ValidationError(`${label} items must be an array`);
  }

  document.sourceFeeds.forEach((feed, index) => {
    if (!isPlainObject(feed)) {
      throw new ValidationError(`${label} sourceFeeds[${index}] must be an object`);
    }
  });

  document.items.forEach((item, index) => {
    validateNormalizedItem(item, `${label} items[${index}]`);
  });

  return document;
}

export function validateNormalizedItem(item, label) {
  if (!isPlainObject(item)) {
    throw new ValidationError(`${label} must be an object`);
  }

  for (const key of REQUIRED_ITEM_KEYS) {
    if (!Object.hasOwn(item, key)) {
      throw new ValidationError(`${label} missing field: ${key}`);
    }
  }

  if (!nonemptyString(item.id)) {
    throw new ValidationError(`${label}.id must be a non-empty string`);
  }

  if (!isPlainObject(item.source)) {
    throw new ValidationError(`${label}.source must be an object`);
  }

  for (const key of REQUIRED_SOURCE_KEYS) {
    if (!Object.hasOwn(item.source, key)) {
      throw new ValidationError(`${label}.source missing field: ${key}`);
    }
  }

  if (!nonemptyString(item.source.type)) {
    throw new ValidationError(`${label}.source.type must be a non-empty string`);
  }

  if (!nonemptyString(item.source.provider)) {
    throw new ValidationError(
      `${label}.source.provider must be a non-empty string`
    );
  }

  if (item.source.url != null && typeof item.source.url !== "string") {
    throw new ValidationError(`${label}.source.url must be a string or null`);
  }

  if (
    item.source.originalId != null &&
    typeof item.source.originalId !== "string"
  ) {
    throw new ValidationError(
      `${label}.source.originalId must be a string or null`
    );
  }

  if (item.source.author != null && !isPlainObject(item.source.author)) {
    throw new ValidationError(`${label}.source.author must be an object or null`);
  }

  for (const key of NULLABLE_STRING_KEYS) {
    if (item[key] != null && typeof item[key] !== "string") {
      throw new ValidationError(`${label}.${key} must be a string or null`);
    }
  }

  if (!isPlainObject(item.scores)) {
    throw new ValidationError(`${label}.scores must be an object`);
  }

  for (const key of SCORE_KEYS) {
    if (!Object.hasOwn(item.scores, key)) {
      throw new ValidationError(`${label}.scores missing field: ${key}`);
    }
    const value = item.scores[key];
    if (value != null && typeof value !== "number") {
      throw new ValidationError(
        `${label}.scores.${key} must be a number or null`
      );
    }
  }
}

export function timestampMsOrNull(value) {
  if (value == null || value === "") return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function compareNullableDesc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

export function comparePoolItems(a, b) {
  const published = compareNullableDesc(
    timestampMsOrNull(a.publishedAt),
    timestampMsOrNull(b.publishedAt)
  );
  if (published !== 0) return published;

  const collected = compareNullableDesc(
    timestampMsOrNull(a.collectedAt),
    timestampMsOrNull(b.collectedAt)
  );
  if (collected !== 0) return collected;

  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function sortPoolItems(items) {
  return [...items].sort(comparePoolItems);
}

export function countBySorted(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((key) => [key, counts[key]])
  );
}

export function buildPoolStats(inputs, items) {
  return {
    inputCount: inputs.length,
    itemCount: items.length,
    byType: countBySorted(items, (item) => item.source.type),
    byProvider: countBySorted(items, (item) => item.source.provider),
  };
}

function attachFeedProvenance(feed, input, inputGeneratedAt) {
  return {
    ...feed,
    inputId: input.id,
    inputPath: input.path,
    inputGeneratedAt,
  };
}

function assertUniqueItemIds(locatedItems) {
  const seen = new Map();
  for (const located of locatedItems) {
    const previous = seen.get(located.item.id);
    if (previous) {
      throw new ValidationError(
        `Duplicate item.id "${located.item.id}" in ${inputLabel(previous.input)} items[${previous.index}] and ${inputLabel(located.input)} items[${located.index}]`
      );
    }
    seen.set(located.item.id, located);
  }
}

async function readNormalizedInput(input, rootDir) {
  const resolvedPath = path.isAbsolute(input.path)
    ? input.path
    : path.join(rootDir, input.path);

  let text;
  try {
    text = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      if (input.required) {
        throw new ValidationError(
          `Required input "${input.id}" is missing: ${input.path}`
        );
      }
      return null;
    }
    throw new ValidationError(
      `Failed to read ${inputLabel(input)}: ${error.message}`,
      { cause: error }
    );
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`${inputLabel(input)} is not valid JSON`, {
      cause: error,
    });
  }

  validateNormalizedDocument(document, inputLabel(input));
  return { input, document };
}

export async function unifyNewsPool(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const config = options.inputsConfig
    ? validateUnifyInputsConfig(options.inputsConfig)
    : await loadUnifyInputs(options.configPath);

  const loaded = [];
  for (const input of config.inputs) {
    const result = await readNormalizedInput(input, rootDir);
    if (result) loaded.push(result);
  }

  if (loaded.length === 0) {
    throw new ValidationError("No unify inputs loaded");
  }

  const locatedItems = [];
  const sourceFeeds = [];

  for (const { input, document } of loaded) {
    for (const feed of document.sourceFeeds) {
      sourceFeeds.push(
        attachFeedProvenance(feed, input, document.generatedAt)
      );
    }
    document.items.forEach((item, index) => {
      locatedItems.push({ input, index, item });
    });
  }

  assertUniqueItemIds(locatedItems);

  const items = sortPoolItems(locatedItems.map((located) => located.item));
  const generatedAt =
    typeof options.now === "function" ? options.now() : new Date().toISOString();
  const stats = buildPoolStats(loaded.map((entry) => entry.input), items);

  const document = {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    generatedAt,
    sourceFeeds,
    stats,
    items,
  };

  if (options.outputPath) {
    await writeJsonAtomic(options.outputPath, document);
  }

  return {
    inputCount: loaded.length,
    itemCount: items.length,
    stats,
    document,
    outputPath: options.outputPath || null,
  };
}
