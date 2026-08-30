import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { writeJsonAtomic } from "../src/lib/atomic-write.js";
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
});
