import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const X_FEED_URL =
  "https://mook-hary.github.io/x-timeline-collector/news-feed.json";

export const RAW_X_FEED_PATH = path.join(
  ROOT_DIR,
  "data",
  "raw",
  "x-news-feed.json"
);

export const NORMALIZED_X_PATH = path.join(
  ROOT_DIR,
  "data",
  "normalized",
  "x-news.json"
);

export const WEB_SOURCES_PATH = path.join(
  ROOT_DIR,
  "config",
  "web-sources.json"
);

export const RAW_WEB_DIR = path.join(ROOT_DIR, "data", "raw", "web");

export const NORMALIZED_WEB_PATH = path.join(
  ROOT_DIR,
  "data",
  "normalized",
  "web-news.json"
);

export const UNIFY_INPUTS_PATH = path.join(
  ROOT_DIR,
  "config",
  "unify-inputs.json"
);

export const NEWS_POOL_PATH = path.join(
  ROOT_DIR,
  "data",
  "normalized",
  "news-pool.json"
);

export const CLUSTER_CONFIG_PATH = path.join(
  ROOT_DIR,
  "config",
  "cluster.json"
);

export const NEWS_CLUSTERS_PATH = path.join(
  ROOT_DIR,
  "data",
  "processed",
  "news-clusters.json"
);

export const NEWS_CLUSTERS_REVIEW_PATH = path.join(
  ROOT_DIR,
  "data",
  "processed",
  "news-clusters-review.json"
);

export { ROOT_DIR };
