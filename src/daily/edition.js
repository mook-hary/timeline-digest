import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FILES, STAGE_ORDER, OUTPUT_KEYS, DEGRADABLE, DAILY_DIAGNOSTICS } from "./contract.js";
import { workPath } from "./state.js";
import { DailyError } from "./fetch.js";
import { assessXFreshness, parseTimestamp } from "./freshness.js";
import { validateXFeed } from "../sources/x-feed.js";
import { joinDigestRecords } from "../sources/digest-inputs.js";
import { assertDigestPartition, buildDigestItem, countDigestStatuses, digestDateOf, fallbackDigestText } from "../sources/digest-document.js";
import { renderDigestMarkdown } from "../sources/digest-markdown.js";
import { validateDigestGeneration } from "../ai/digest-generator.js";
import { loadDigestConfig } from "../sources/digest-config.js";
import { digestPayloadForRecord } from "../sources/digest-run.js";
import { buildReferencesCandidates } from "../sources/references-candidates.js";
import { buildReferencesSelection, validateReferencesCandidates } from "../sources/references-selection.js";
import { loadReferencesSelectionConfig } from "../sources/references-selection-config.js";
import { DIGEST_CONFIG_PATH, REFERENCES_SELECTION_CONFIG_PATH } from "../config.js";
import { writeJsonAtomic, writeTextAtomic } from "../lib/atomic-write.js";

const requireValue = value => { if (!value) throw new DailyError("edition_invalid"); };
export const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");
const candidateFiles = { digest: FILES.editionDigest, markdown: FILES.editionMarkdown, references: FILES.editionReferences };

async function validateStageEvidence(ctx) {
  const completed = ctx.stages.filter(s => s.id !== "validate-edition");
  requireValue(isDeepStrictEqual(completed.map(s => s.id), STAGE_ORDER.slice(0, -1)));
  for (const stage of completed) {
    requireValue(stage.status === "succeeded" || (stage.status === "degraded" && DEGRADABLE.has(stage.id)));
    requireValue(parseTimestamp(stage.startedAt) >= parseTimestamp(ctx.startedAt));
    requireValue(parseTimestamp(stage.finishedAt) >= parseTimestamp(stage.startedAt));
    requireValue(Array.isArray(stage.diagnostics) && stage.diagnostics.every(code => DAILY_DIAGNOSTICS.has(code)));
    requireValue(stage.status === "degraded" ? stage.diagnostics.length > 0 : stage.diagnostics.length === 0);
    const expected = OUTPUT_KEYS[stage.id].map(key => FILES[key]);
    requireValue(Array.isArray(stage.artifacts) && isDeepStrictEqual(stage.artifacts.map(a => a.path), expected));
    for (const artifact of stage.artifacts) requireValue(hashBytes(await fs.readFile(workPath(ctx.workDir, artifact.path))) === artifact.sha256);
  }
  return completed;
}

export async function validateDigestDocument(document, { selected, evaluated, pool, markdown }) {
  requireValue(document?.schemaVersion === 1 && Array.isArray(document.items));
  parseTimestamp(document.generatedAt);
  requireValue(document.digestDate === digestDateOf(document.generatedAt));
  requireValue(document.sourceSelection?.path === FILES.selected && document.sourceSelection.generatedAt === selected.generatedAt);
  requireValue(document.stats?.applyAi === true && document.stats.dryRun === false && document.stats.requestLimit === null);
  const records = joinDigestRecords({ selected, evaluated, pool });
  assertDigestPartition(records, document.items);
  requireValue(document.stats.inputSelected === records.length);
  const config = await loadDigestConfig(DIGEST_CONFIG_PATH);
  for (const [index, item] of document.items.entries()) {
    requireValue(["ok", "failed", "fallback"].includes(item.status));
    requireValue(typeof item.generation?.model === "string" && item.generation.model.length > 0);
    requireValue(typeof item.generation.generatorVersion === "string" && typeof item.generation.cacheHit === "boolean");
    const text = { headline: item.headline, summary: item.summary, whyItMatters: item.whyItMatters };
    if (item.status === "ok") {
      const payload = digestPayloadForRecord(records[index], config).payload;
      requireValue(validateDigestGeneration(text, { groundedInput: payload.input, headlineMinChars: config.headlineMinChars,
        headlineMaxChars: config.headlineMaxChars, summaryMaxChars: config.summaryMaxChars, whyItMattersMaxChars: config.whyItMattersMaxChars }).status === "ok");
    } else requireValue(isDeepStrictEqual(text, fallbackDigestText(records[index])));
    requireValue(isDeepStrictEqual(item, buildDigestItem(records[index], { ...item.generation, status: item.status }, text)));
  }
  const counts = countDigestStatuses(document.items);
  for (const [status, count] of Object.entries(counts)) requireValue(document.stats[status] === count);
  requireValue(markdown === renderDigestMarkdown(document));
  return document;
}

async function validateSources(ctx, now) {
  const read = async key => JSON.parse(await fs.readFile(workPath(ctx.workDir, FILES[key]), "utf8"));
  const stages = await validateStageEvidence(ctx);
  const x = await read("xReceipt"), web = await read("webReceipt");
  const xFeed = validateXFeed(await read("xRaw"));
  requireValue(x.collectionCompletedAt === xFeed.collectionCompletedAt && x.generatedAt === xFeed.generatedAt && x.itemCount === xFeed.items.length);
  assessXFreshness(xFeed, { now, policy: ctx.config.freshness.x, retrieval: x, runId: ctx.runId, startedAt: ctx.startedAt });
  requireValue(web.runId === ctx.runId && Array.isArray(web.sources) && web.sources.some(s => s.status === "succeeded"));
  for (const source of web.sources.filter(s => s.status === "succeeded")) {
    requireValue(parseTimestamp(source.fetchedAt) >= parseTimestamp(ctx.startedAt));
    requireValue(parseTimestamp(source.fetchedAt) <= parseTimestamp(now) + ctx.config.freshness.x.futureToleranceMinutes * 60000);
  }
  const [selected, evaluated, pool, digest, candidates, references] = await Promise.all(["selected", "evaluated", "pool", "digest", "candidates", "references"].map(read));
  const markdown = await fs.readFile(workPath(ctx.workDir, FILES.markdown), "utf8");
  await validateDigestDocument(digest, { selected, evaluated, pool, markdown });
  validateReferencesCandidates(candidates);
  requireValue(isDeepStrictEqual(candidates, buildReferencesCandidates(pool, { generatedAt: candidates.generatedAt })));
  parseTimestamp(references.generatedAt);
  const config = await loadReferencesSelectionConfig(REFERENCES_SELECTION_CONFIG_PATH);
  requireValue(isDeepStrictEqual(references, buildReferencesSelection(candidates, config, {
    generatedAt: references.generatedAt, sourceCandidatesPath: FILES.candidates,
  })));
  // A valid artifact cannot suppress a required degradation.
  const diag = id => stages.find(stage => stage.id === id).diagnostics;
  requireValue(!web.sources.some(s => s.status === "failed") || diag("ingest:web").includes("web_source_failed"));
  requireValue(!web.sources.some(s => s.diagnostic === "web_metadata_old") || diag("ingest:web").includes("web_metadata_old"));
  requireValue(!digest.items.some(i => i.status !== "ok") || diag("digest").includes("digest_fallback"));
  requireValue(candidates.items.length > 0 || diag("references").includes("references_empty"));
  return { x, web, digest, references, stages };
}

async function validateManifest(ctx, manifest, now, sources) {
  requireValue(manifest.schemaVersion === 1 && manifest.kind === "edition-candidate" && manifest.status === "validated");
  requireValue(manifest.runId === ctx.runId && manifest.startedAt === ctx.startedAt);
  requireValue(manifest.editionDate === digestDateOf(ctx.startedAt));
  requireValue(parseTimestamp(manifest.createdAt) >= parseTimestamp(ctx.startedAt));
  requireValue(manifest.createdAt === now || parseTimestamp(manifest.createdAt) <= parseTimestamp(now));
  requireValue(isDeepStrictEqual(manifest.inputs, { x: sources.x, web: sources.web }));
  requireValue(isDeepStrictEqual(manifest.stages, sources.stages));
  requireValue(isDeepStrictEqual(manifest.degradedDiagnostics, sources.stages.filter(s => s.status === "degraded").map(s => ({ stage: s.id, codes: s.diagnostics }))));
  requireValue(manifest.digestItemCount === sources.digest.items.length && isDeepStrictEqual(manifest.referencesCounts, sources.references.stats));
  requireValue(isDeepStrictEqual(Object.keys(manifest.files).sort(), Object.keys(candidateFiles).sort()));
  const originals = { digest: FILES.digest, markdown: FILES.markdown, references: FILES.references };
  for (const [name, relative] of Object.entries(candidateFiles)) {
    const descriptor = manifest.files[name];
    requireValue(descriptor.path === relative);
    const bytes = await fs.readFile(workPath(ctx.workDir, descriptor.path));
    requireValue(hashBytes(bytes) === descriptor.sha256);
    requireValue(bytes.equals(await fs.readFile(workPath(ctx.workDir, originals[name]))));
  }
}

export async function validateEditionCandidate(ctx, { now }) {
  const sources = await validateSources(ctx, now);
  const manifest = JSON.parse(await fs.readFile(workPath(ctx.workDir, FILES.manifest), "utf8"));
  await validateManifest(ctx, manifest, now, sources);
  return manifest;
}

export async function createEditionCandidate(ctx, { now }) {
  const sources = await validateSources(ctx, now);
  const files = {};
  for (const [name, original] of Object.entries({ digest: FILES.digest, markdown: FILES.markdown, references: FILES.references })) {
    const bytes = await fs.readFile(workPath(ctx.workDir, original));
    const relative = candidateFiles[name];
    await writeTextAtomic(workPath(ctx.workDir, relative), bytes.toString("utf8"));
    files[name] = { path: relative, sha256: hashBytes(bytes) };
  }
  const manifest = {
    schemaVersion: 1, kind: "edition-candidate", status: "validated", runId: ctx.runId,
    startedAt: ctx.startedAt, editionDate: digestDateOf(ctx.startedAt), createdAt: now,
    inputs: { x: sources.x, web: sources.web }, stages: sources.stages,
    digestItemCount: sources.digest.items.length, referencesCounts: sources.references.stats,
    degradedDiagnostics: sources.stages.filter(s => s.status === "degraded").map(s => ({ stage: s.id, codes: s.diagnostics })), files,
  };
  await validateManifest(ctx, manifest, now, sources);
  // Final marker only after content, provenance, freshness and hashes validate.
  await writeJsonAtomic(workPath(ctx.workDir, FILES.manifest), manifest);
  return manifest;
}
