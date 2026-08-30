import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { loadRootEnv } from "../src/load-env.js";
import { resolveSemanticModel } from "../src/sources/semantic-config.js";
import { makeTempDir } from "./helpers.js";

describe("loadRootEnv", () => {
  it("loads root .env into the provided env object without logging values", async () => {
    const root = await makeTempDir("load-env-");
    const placeholder = "dotenv-test-placeholder";
    await fs.writeFile(
      path.join(root, ".env"),
      `OPENAI_API_KEY=${placeholder}\nSEMANTIC_MODEL=gpt-5-mini\n`,
      "utf8"
    );
    const env = {};
    const chunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk, ...rest) => {
      chunks.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };
    process.stderr.write = (chunk, ...rest) => {
      chunks.push(String(chunk));
      return originalErr(chunk, ...rest);
    };
    try {
      const result = loadRootEnv({ rootDir: root, processEnv: env });
      assert.equal(result.error, undefined);
      assert.equal(env.OPENAI_API_KEY, placeholder);
      assert.equal(env.SEMANTIC_MODEL, "gpt-5-mini");
    } finally {
      process.stdout.write = originalWrite;
      process.stderr.write = originalErr;
    }
    const printed = chunks.join("");
    assert.equal(printed.includes(placeholder), false);
  });

  it("does not override existing environment variables", async () => {
    const root = await makeTempDir("load-env-keep-");
    await fs.writeFile(
      path.join(root, ".env"),
      "OPENAI_API_KEY=from-file\nSEMANTIC_MODEL=from-file\n",
      "utf8"
    );
    const env = { OPENAI_API_KEY: "already-set", SEMANTIC_MODEL: "already-set" };
    loadRootEnv({ rootDir: root, processEnv: env });
    assert.equal(env.OPENAI_API_KEY, "already-set");
    assert.equal(env.SEMANTIC_MODEL, "already-set");
  });
});

describe("resolveSemanticModel", () => {
  const config = { model: "gpt-4o-mini" };

  it("uses SEMANTIC_MODEL, then OPENAI_MODEL, then config.model", () => {
    assert.equal(
      resolveSemanticModel(config, { SEMANTIC_MODEL: "gpt-5-mini" }),
      "gpt-5-mini"
    );
    assert.equal(
      resolveSemanticModel(config, { OPENAI_MODEL: "gpt-5-mini" }),
      "gpt-5-mini"
    );
    assert.equal(resolveSemanticModel(config, {}), "gpt-4o-mini");
    assert.equal(
      resolveSemanticModel(config, {
        SEMANTIC_MODEL: "semantic-first",
        OPENAI_MODEL: "openai-second",
      }),
      "semantic-first"
    );
  });
});
