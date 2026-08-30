import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  CLUSTER_CONFIG_PATH,
  NEWS_CLUSTERS_PATH,
  NEWS_CLUSTERS_REVIEW_PATH,
  NEWS_POOL_PATH,
} from "./config.js";
import { loadClusterConfig } from "./sources/cluster-config.js";
import { clusterNewsPool } from "./sources/news-clusters.js";

function formatCountMap(title, counts) {
  const lines = [title];
  for (const key of Object.keys(counts)) {
    lines.push(`${key}: ${counts[key]}`);
  }
  return lines;
}

export async function runCluster(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const clusterConfig =
      options.clusterConfig ||
      (await loadClusterConfig(options.clusterConfigPath ?? CLUSTER_CONFIG_PATH));

    const result = await clusterNewsPool({
      pool: options.pool,
      poolPath: options.poolPath ?? NEWS_POOL_PATH,
      clusterConfig,
      sourcePoolPath: options.sourcePoolPath ?? "data/normalized/news-pool.json",
      outputPath: options.outputPath ?? NEWS_CLUSTERS_PATH,
      reviewPath: options.reviewPath ?? NEWS_CLUSTERS_REVIEW_PATH,
      now: options.now,
      rootDir: options.rootDir,
    });

    stdout.write(
      [
        "News Clusters:",
        "",
        `items: ${result.stats.itemCount}`,
        `clusters: ${result.stats.clusterCount}`,
        `multi-item: ${result.stats.multiItemClusterCount}`,
        `singletons: ${result.stats.singletonCount}`,
        `relationships: ${result.stats.relationshipCount}`,
        "",
        ...formatCountMap("Relationship:", result.stats.byRelationshipType),
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
  process.exitCode = await runCluster();
}
