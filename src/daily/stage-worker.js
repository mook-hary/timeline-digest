import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { workPath } from "./state.js";

try {
  const { moduleUrl, context } = workerData;
  let result;
  if (moduleUrl === null) {
    // Explicit CLI self-test only. No pipeline imports or network operations.
    fs.writeFileSync(workPath(context.workDir, "foundation.json"), JSON.stringify({ runId: context.runId, fixture: true }));
    result = { status: "succeeded" };
  } else {
    const adapter = await import(moduleUrl);
    result = await adapter.default({ ...context, workPath: relative => workPath(context.workDir, relative),
      writeJson(relative, value) {
        const file = workPath(context.workDir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value));
      } });
  }
  parentPort.postMessage({ status: result?.status });
} catch {
  // Never persist module errors, environment values, stack traces or payloads.
  parentPort.postMessage({ status: "failed" });
}
parentPort.close();
