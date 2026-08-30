import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { NEWS_POOL_PATH, UNIFY_INPUTS_PATH } from "./config.js";
import { unifyNewsPool } from "./sources/news-pool.js";

function formatCountMap(title, counts) {
  const lines = [title];
  for (const key of Object.keys(counts)) {
    lines.push(`${key}: ${counts[key]}`);
  }
  return lines;
}

export async function runUnify(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const result = await unifyNewsPool({
      configPath: options.configPath ?? UNIFY_INPUTS_PATH,
      inputsConfig: options.inputsConfig,
      rootDir: options.rootDir,
      outputPath: options.outputPath ?? NEWS_POOL_PATH,
      now: options.now,
    });

    stdout.write(
      [
        "Unified News Pool:",
        "",
        `inputs: ${result.inputCount}`,
        `items: ${result.itemCount}`,
        "",
        ...formatCountMap("Type:", result.stats.byType),
        "",
        ...formatCountMap("Provider:", result.stats.byProvider),
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
  process.exitCode = await runUnify();
}
