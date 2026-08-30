import fs from "node:fs/promises";
import path from "node:path";

export async function writeTextAtomic(filePath, text) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  const tmpPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const body = typeof text === "string" ? text : String(text);

  try {
    await fs.writeFile(tmpPath, body, "utf8");
    await fs.rename(tmpPath, resolved);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }

  return resolved;
}

export async function writeJsonAtomic(filePath, data) {
  return writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
