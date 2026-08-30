/**
 * Load repo-root .env into process.env (dotenv).
 * Does not log values. Does not override existing environment variables.
 */
import path from "node:path";
import dotenv from "dotenv";
import { ROOT_DIR } from "./config.js";

export function loadRootEnv(options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const envPath = path.join(rootDir, ".env");
  const config = {
    path: envPath,
    quiet: true,
  };
  if (options.processEnv) {
    config.processEnv = options.processEnv;
  }
  return dotenv.config(config);
}
