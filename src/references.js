import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { NEWS_POOL_PATH, REFERENCES_CANDIDATES_PATH } from "./config.js";
import { generateReferencesCandidates } from "./sources/references-candidates.js";

export async function runReferences(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const { document } = await generateReferencesCandidates({
      pool: options.pool,
      poolPath: options.poolPath ?? NEWS_POOL_PATH,
      outputPath: options.outputPath ?? REFERENCES_CANDIDATES_PATH,
      threshold: options.threshold,
      now: options.now,
    });
    stdout.write(`References Candidates:\nitems: ${document.sourcePool.itemCount}\ncandidates: ${document.candidateCount}\nthreshold: ${document.threshold}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message || String(error)}\n`);
    return 1;
  }
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) process.exitCode = await runReferences();
