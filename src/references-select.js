import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { REFERENCES_CANDIDATES_PATH, REFERENCES_SELECTION_CONFIG_PATH, REFERENCES_PATH } from "./config.js";
import { loadReferencesSelectionConfig, validateReferencesSelectionConfig } from "./sources/references-selection-config.js";
import { runReferencesSelectionPipeline } from "./sources/references-selection.js";

export async function runReferencesSelect(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const selectionConfig = options.selectionConfig === undefined
      ? await loadReferencesSelectionConfig(options.configPath ?? REFERENCES_SELECTION_CONFIG_PATH)
      : validateReferencesSelectionConfig(options.selectionConfig);
    const { document } = await runReferencesSelectionPipeline({
      selectionConfig, candidates: options.candidates,
      candidatesPath: options.candidatesPath ?? REFERENCES_CANDIDATES_PATH,
      outputPath: options.outputPath ?? REFERENCES_PATH,
      now: options.now,
    });
    const { stats, selectionPolicy } = document;
    stdout.write([
      "References Selection", `input: ${stats.inputCandidates}`,
      `selected: ${stats.selected}`, `secondary: ${stats.secondary}`, `evidence: ${stats.evidence}`,
      `policy: ${selectionPolicy.id}`, `primaryMinValue: ${selectionPolicy.primaryMinValue}`, "",
    ].join("\n"));
    return 0;
  } catch (error) {
    stderr.write(`${error.message || String(error)}\n`);
    return 1;
  }
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) process.exitCode = await runReferencesSelect();
