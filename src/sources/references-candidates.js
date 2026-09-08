import fs from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-write.js";
import { ValidationError } from "../lib/errors.js";
import { validateNormalizedDocument } from "./news-pool.js";
import { normalizeVision, normalizeVisual, normalizeXMedia } from "./x-visual.js";

export const DEFAULT_REFERENCES_THRESHOLD = 3;

export function buildReferencesCandidates(pool, {
  threshold = DEFAULT_REFERENCES_THRESHOLD,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 5) {
    throw new ValidationError("References threshold must be an integer from 1 to 5");
  }
  validateNormalizedDocument(pool, "news-pool");
  const items = [];
  for (const item of pool.items) {
    if (item.source.type !== "x") continue;
    const visual = normalizeVisual(item.visual);
    if (visual.value === null || visual.value < threshold) continue;
    const media = normalizeXMedia(item.media);
    if (media.length === 0) continue;
    const source = item.source;
    items.push({
      id: item.id,
      source: {
        type: source.type,
        provider: source.provider,
        url: source.url,
        originalId: source.originalId,
        author: {
          name: typeof source.author?.name === "string" ? source.author.name : null,
          handle: typeof source.author?.handle === "string" ? source.author.handle : null,
        },
      },
      title: item.title,
      summary: item.summary,
      publishedAt: item.publishedAt,
      media,
      vision: normalizeVision(item.vision),
      visual,
    });
  }
  items.sort((a, b) => b.visual.value - a.visual.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schemaVersion: 1,
    generatedAt,
    sourcePool: { generatedAt: pool.generatedAt, itemCount: pool.items.length },
    threshold,
    candidateCount: items.length,
    items,
  };
}

export async function generateReferencesCandidates(options = {}) {
  let pool = options.pool;
  if (!pool) {
    let text;
    try {
      text = await fs.readFile(options.poolPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new ValidationError(`News pool is missing: ${options.poolPath}. Run npm run unify with existing normalized inputs first.`);
      }
      throw new ValidationError(`Failed to read news pool: ${error.message}`, { cause: error });
    }
    try { pool = JSON.parse(text); } catch (error) {
      throw new ValidationError("News pool is not valid JSON", { cause: error });
    }
  }
  const document = buildReferencesCandidates(pool, {
    threshold: options.threshold,
    generatedAt: options.now ? options.now() : new Date().toISOString(),
  });
  if (options.outputPath) await writeJsonAtomic(options.outputPath, document);
  return { document, outputPath: options.outputPath || null };
}
