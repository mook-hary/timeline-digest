import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { writeJsonAtomic, writeTextAtomic } from "../src/lib/atomic-write.js";
import { makeTempDir } from "./helpers.js";

describe("atomic write", () => {
  it("Case K: writes JSON via tmp + rename and leaves no tmp file", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "nested", "out.json");
    const payload = { ok: true, count: 2, items: ["a", "b"] };

    const written = await writeJsonAtomic(filePath, payload);
    assert.equal(written, filePath);

    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(parsed, payload);

    const leftover = (await readdir(path.dirname(filePath))).filter((name) =>
      name.endsWith(".tmp")
    );
    assert.deepEqual(leftover, []);
  });

  it("Case N: writes raw XML via tmp + rename and leaves no tmp file", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "raw", "example.xml");
    const xml = '<?xml version="1.0"?><rss version="2.0"></rss>\n';

    const written = await writeTextAtomic(filePath, xml);
    assert.equal(written, filePath);
    assert.equal(await readFile(filePath, "utf8"), xml);

    const leftover = (await readdir(path.dirname(filePath))).filter((name) =>
      name.endsWith(".tmp")
    );
    assert.deepEqual(leftover, []);
  });
});
