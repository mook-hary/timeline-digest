import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  NORMALIZED_X_PATH,
  RAW_X_FEED_PATH,
  X_FEED_URL,
} from "./config.js";
import { ingestXFeed } from "./sources/x-feed.js";

export async function runIngestX(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const result = await ingestXFeed({
      url: options.url ?? X_FEED_URL,
      rawPath: options.rawPath ?? RAW_X_FEED_PATH,
      normalizedPath: options.normalizedPath ?? NORMALIZED_X_PATH,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });

    stdout.write(
      [
        "X Feed:",
        `fetched: ${result.fetched}`,
        `normalized: ${result.normalized}`,
        `generatedAt: ${result.generatedAt}`,
        "",
      ].join("\n")
    );
    return 0;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await runIngestX();
}
