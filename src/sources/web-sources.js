import fs from "node:fs/promises";
import { ValidationError } from "../lib/errors.js";

const SOURCE_ID = /^[a-z0-9][a-z0-9-]*$/;
const FEED_TYPES = new Set(["rss", "atom"]);

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireHttpUrl(value, label) {
  const url = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ValidationError(`${label} must be an http(s) URL`);
  }
  return url;
}

export function validateWebSourcesConfig(data) {
  if (!isPlainObject(data)) {
    throw new ValidationError("Web sources config must be an object");
  }
  if (data.schemaVersion !== 1) {
    throw new ValidationError(
      `Unsupported web sources schemaVersion: ${data.schemaVersion}`
    );
  }
  if (!Array.isArray(data.sources)) {
    throw new ValidationError("Web sources config sources must be an array");
  }

  const seen = new Map();
  const sources = data.sources.map((source, index) => {
    if (!isPlainObject(source)) {
      throw new ValidationError(`sources[${index}] must be an object`);
    }

    const id = requireString(source.id, `sources[${index}].id`);
    if (!SOURCE_ID.test(id)) {
      throw new ValidationError(
        `sources[${index}].id must match ${SOURCE_ID}`
      );
    }
    if (seen.has(id)) {
      throw new ValidationError(
        `Duplicate source id "${id}" at sources[${seen.get(id)}] and sources[${index}]`
      );
    }
    seen.set(id, index);

    const name = requireString(source.name, `sources[${index}].name`);
    const url = requireHttpUrl(source.url, `sources[${index}].url`);
    const type = requireString(source.type || "rss", `sources[${index}].type`);
    if (!FEED_TYPES.has(type)) {
      throw new ValidationError(
        `sources[${index}].type must be "rss" or "atom"`
      );
    }
    if (typeof source.enabled !== "boolean") {
      throw new ValidationError(`sources[${index}].enabled must be a boolean`);
    }

    let defaultCategory = null;
    if (source.defaultCategory != null) {
      defaultCategory = requireString(
        source.defaultCategory,
        `sources[${index}].defaultCategory`
      );
    }

    return {
      id,
      name,
      type,
      url,
      enabled: source.enabled,
      defaultCategory,
    };
  });

  return {
    schemaVersion: 1,
    sources,
  };
}

export async function loadWebSources(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new ValidationError(
      `Failed to read web sources config: ${error.message}`,
      { cause: error }
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ValidationError("Web sources config is not valid JSON", {
      cause: error,
    });
  }

  return validateWebSourcesConfig(data);
}

export function enabledWebSources(config) {
  return config.sources.filter((source) => source.enabled);
}
