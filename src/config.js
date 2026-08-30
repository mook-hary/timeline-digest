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

export { ROOT_DIR };
