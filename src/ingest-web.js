import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  NORMALIZED_WEB_PATH,
  RAW_WEB_DIR,
  WEB_SOURCES_PATH,
} from "./config.js";
import { ingestWebFeeds } from "./sources/web-feed.js";

export function webIngestExitCode(result) {
  if (!result || result.sources === 0) return 1;
  if (result.success === 0) return 1;
  if (result.failed > 0) return 2;
  return 0;
}

export async function runIngestWeb(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const result = await ingestWebFeeds({
      configPath: options.configPath ?? WEB_SOURCES_PATH,
      sourcesConfig: options.sourcesConfig,
      rawDir: options.rawDir ?? RAW_WEB_DIR,
      normalizedPath: options.normalizedPath ?? NORMALIZED_WEB_PATH,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });

    const lines = [
      "Web News:",
      "",
      `sources: ${result.sources}`,
      `success: ${result.success}`,
      `failed: ${result.failed}`,
      `items: ${result.itemCount}`,
      "",
      "Source:",
    ];

    for (const sourceResult of result.sourceResults) {
      if (sourceResult.status === "ok") {
        lines.push(
          `${sourceResult.source.name}: ${sourceResult.items.length}`
        );
      } else {
        lines.push(`${sourceResult.source.name}: failed`);
      }
    }

    const failures = result.sourceResults.filter(
      (sourceResult) => sourceResult.status === "error"
    );
    if (failures.length > 0) {
      lines.push("", "Failed:");
      for (const failure of failures) {
        const line = `${failure.source.name}: ${failure.error}`;
        lines.push(line);
        stderr.write(`${line}\n`);
      }
    }

    stdout.write(`${lines.join("\n")}\n`);
    return webIngestExitCode(result);
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
  process.exitCode = await runIngestWeb();
}
