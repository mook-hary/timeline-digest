import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures"
);

export function fixturePath(name) {
  return path.join(FIXTURES_DIR, name);
}

export function loadFixture(name) {
  return JSON.parse(readFileSync(fixturePath(name), "utf8"));
}

export function loadFixtureText(name) {
  return readFileSync(fixturePath(name), "utf8");
}

export function mockFetchJson(body, { status = 200 } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return async () =>
    new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

export function mockFetchNetworkError(message = "ECONNREFUSED") {
  return async () => {
    throw new Error(message);
  };
}

export async function makeTempDir(prefix = "timeline-digest-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function collectWriter() {
  let text = "";
  return {
    write(chunk) {
      text += chunk;
      return true;
    },
    toString() {
      return text;
    },
  };
}
