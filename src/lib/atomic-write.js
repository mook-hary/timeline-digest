import fs from "node:fs/promises";
import path from "node:path";

export async function writeJsonAtomic(filePath, data) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  const tmpPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(data, null, 2)}\n`;

  try {
    await fs.writeFile(tmpPath, json, "utf8");
    await fs.rename(tmpPath, resolved);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }

  return resolved;
}
