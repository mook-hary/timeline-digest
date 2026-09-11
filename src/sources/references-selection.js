import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "../config.js";
import { writeJsonAtomic } from "../lib/atomic-write.js";
import { ValidationError } from "../lib/errors.js";
import { validateReferencesSelectionConfig } from "./references-selection-config.js";

// Candidate public schema, independent of source-specific normalization.
const ROLES = new Set([
  "evidence", "reference", "diagram", "artwork", "screenshot", "photo",
  "production-material", "other",
]);
const MEDIA_TYPES = new Set(["image", "video", "gif", "unknown"]);

function requireValue(ok, label) {
  if (!ok) throw new ValidationError(`Invalid references candidates: ${label}`);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
  return typeof value === "string" && value.trim() !== "";
}
function nullableText(value) {
  return value === null || typeof value === "string";
}
function valueInRange(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}
function count(value) {
  return Number.isInteger(value) && value >= 0;
}
function mediaUrl(value) {
  if (value === null) return true;
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

export function validateReferencesCandidates(document) {
  requireValue(object(document), "document must be an object");
  requireValue(document.schemaVersion === 1, `unsupported schemaVersion: ${document.schemaVersion}`);
  requireValue(text(document.generatedAt), "generatedAt must be a non-empty string");
  requireValue(object(document.sourcePool), "sourcePool must be an object");
  requireValue(text(document.sourcePool.generatedAt), "sourcePool.generatedAt must be a non-empty string");
  requireValue(count(document.sourcePool.itemCount), "sourcePool.itemCount must be a non-negative integer");
  requireValue(valueInRange(document.threshold), "threshold must be an integer from 1 to 5");
  requireValue(Array.isArray(document.items), "items must be an array");
  requireValue(count(document.candidateCount) && document.candidateCount === document.items.length,
    "candidateCount must equal items.length");
  requireValue(document.sourcePool.itemCount >= document.candidateCount, "sourcePool.itemCount is smaller than candidateCount");
  const ids = new Set();
  for (const [index, item] of document.items.entries()) {
    const label = `items[${index}]`;
    requireValue(object(item), `${label} must be an object`);
    requireValue(text(item.id), `${label}.id must be a non-empty string`);
    requireValue(!ids.has(item.id), `duplicate candidate id: ${item.id}`);
    ids.add(item.id);
    requireValue(object(item.source), `${label}.source must be an object`);
    for (const key of ["type", "provider"]) requireValue(text(item.source[key]), `${label}.source.${key}`);
    for (const key of ["url", "originalId"]) requireValue(nullableText(item.source[key]), `${label}.source.${key}`);
    requireValue(object(item.source.author), `${label}.source.author must be an object`);
    for (const key of ["name", "handle"]) requireValue(nullableText(item.source.author[key]), `${label}.source.author.${key}`);
    for (const key of ["title", "summary", "publishedAt"]) requireValue(nullableText(item[key]), `${label}.${key}`);
    requireValue(object(item.visual) && valueInRange(item.visual.value), `${label}.visual.value must be an integer from 1 to 5`);
    requireValue(Array.isArray(item.visual.roles) && item.visual.roles.every((role) => ROLES.has(role)), `${label}.visual.roles`);
    requireValue(new Set(item.visual.roles).size === item.visual.roles.length, `${label}.visual.roles contains duplicates`);
    requireValue(item.vision === null || (object(item.vision) && item.vision.status === "ok" &&
      text(item.vision.observations) && nullableText(item.vision.visibleText)), `${label}.vision`);
    requireValue(Array.isArray(item.media) && item.media.length > 0, `${label}.media must be a non-empty array`);
    for (const [mediaIndex, media] of item.media.entries()) {
      const m = `${label}.media[${mediaIndex}]`;
      requireValue(object(media), `${m} must be an object`);
      requireValue(MEDIA_TYPES.has(media.type), `${m}.type`);
      requireValue(mediaUrl(media.url) && mediaUrl(media.previewUrl) &&
        (media.url !== null || media.previewUrl !== null), `${m}.url/previewUrl must contain an HTTPS URL`);
      requireValue(nullableText(media.altText), `${m}.altText`);
      for (const key of ["width", "height"]) requireValue(media[key] === null ||
        (Number.isInteger(media[key]) && media[key] > 0), `${m}.${key}`);
    }
  }
  return document;
}

function copyCandidate(item, primaryMinValue) {
  const selected = item.visual.value >= primaryMinValue;
  return {
    id: item.id,
    source: {
      type: item.source.type, provider: item.source.provider,
      url: item.source.url, originalId: item.source.originalId,
      author: { name: item.source.author.name, handle: item.source.author.handle },
    },
    title: item.title,
    summary: item.summary,
    publishedAt: item.publishedAt,
    media: item.media.map((media) => ({
      type: media.type, url: media.url, previewUrl: media.previewUrl,
      altText: media.altText, width: media.width, height: media.height,
    })),
    vision: item.vision === null ? null : {
      status: item.vision.status, observations: item.vision.observations,
      visibleText: item.vision.visibleText,
    },
    visual: { value: item.visual.value, roles: item.visual.roles.slice() },
    selection: {
      status: selected ? "selected" : "secondary",
      reason: selected ? "meets-primary-threshold" : "below-primary-threshold",
    },
  };
}

export function buildReferencesSelection(candidates, selectionConfig, {
  generatedAt = new Date().toISOString(),
  sourceCandidatesPath = "data/processed/references-candidates.json",
} = {}) {
  const config = validateReferencesSelectionConfig(selectionConfig);
  validateReferencesCandidates(candidates);
  if (candidates.threshold > config.primaryMinValue) {
    throw new ValidationError(`Candidate threshold ${candidates.threshold} exceeds primaryMinValue ${config.primaryMinValue}. Regenerate Candidates with threshold <= ${config.primaryMinValue}; selection cannot recover filtered-out candidates.`);
  }
  const items = candidates.items.map((item) => copyCandidate(item, config.primaryMinValue));
  const selected = items.filter((item) => item.selection.status === "selected").length;
  const secondary = items.filter((item) => item.selection.status === "secondary").length;
  requireValue(selected + secondary === candidates.candidateCount, "selection partition mismatch");
  return {
    schemaVersion: 1,
    generatedAt,
    sourceCandidates: {
      path: sourceCandidatesPath, generatedAt: candidates.generatedAt, threshold: candidates.threshold,
    },
    selectionPolicy: { id: config.policyId, primaryMinValue: config.primaryMinValue },
    stats: {
      inputCandidates: items.length, selected, secondary,
      evidence: items.filter((item) => item.visual.roles.includes("evidence")).length,
    },
    items,
  };
}

export async function runReferencesSelectionPipeline(options = {}) {
  let candidates = options.candidates;
  if (candidates === undefined) {
    let text;
    try { text = await fs.readFile(options.candidatesPath, "utf8"); } catch (error) {
      if (error.code === "ENOENT") {
        throw new ValidationError(`References Candidates is missing: ${options.candidatesPath}. Run npm run references with an existing Unified Pool first.`);
      }
      throw new ValidationError(`Failed to read References Candidates: ${error.message}`, { cause: error });
    }
    try { candidates = JSON.parse(text); } catch (error) {
      throw new ValidationError("References Candidates is not valid JSON", { cause: error });
    }
  }
  const sourceCandidatesPath = options.sourceCandidatesPath ?? (options.candidatesPath
    ? path.relative(options.rootDir ?? ROOT_DIR, path.resolve(options.candidatesPath)).replaceAll("\\", "/")
    : "data/processed/references-candidates.json");
  const document = buildReferencesSelection(candidates, options.selectionConfig, {
    generatedAt: options.now ? options.now() : new Date().toISOString(), sourceCandidatesPath,
  });
  if (options.outputPath) await writeJsonAtomic(options.outputPath, document);
  return { document, outputPath: options.outputPath ?? null };
}
