import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDaily } from "./daily/run.js";
import { recoverLock } from "./daily/lock.js";

export async function runDailyCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const root = fileURLToPath(new URL("../data/daily", import.meta.url));
  if (argv.length !== 1 || !["--self-test", "--recover-lock"].includes(argv[0])) {
    stderr.write("Daily production pipeline is not wired (Phase 1). Use --self-test for a local fixture run or --recover-lock for explicit recovery.\n");
    return 1;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (argv[0] === "--recover-lock") {
      recoverLock(root);
      stdout.write("Dead local Daily lock recovered. No run started.\n");
      return 0;
    }
    const { state } = await runDaily({ root, stages: [{ id: "foundation", moduleUrl: null }], signal: controller.signal });
    stdout.write(`Foundation self-test only: ${state.runId} ${state.status}; no edition produced.\n`);
    return ["succeeded", "succeeded_degraded"].includes(state.status) ? 0 : 1;
  } catch {
    stderr.write("Daily foundation failed; inspect local run state/lock. No edition produced.\n");
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runDailyCli();
