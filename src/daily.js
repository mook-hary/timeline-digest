import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProductionDaily } from "./daily/pipeline.js";
import { loadRootEnv } from "./load-env.js";
import { runDaily } from "./daily/run.js";
import { recoverLock } from "./daily/lock.js";

export async function runDailyCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, root: rootOverride, productionRunner = runProductionDaily, environment } = {}) {
  const root = rootOverride ?? fileURLToPath(new URL("../data/daily", import.meta.url));
  if (argv.length > 1 || (argv.length === 1 && !["--self-test", "--recover-lock"].includes(argv[0]))) {
    stderr.write("Usage: daily [--self-test | --recover-lock]. Default validates and atomically promotes an edition.\n");
    return 1;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (argv[0] === "--recover-lock") {
      recoverLock(root);
      stdout.write("Daily recovery/reconciliation complete. No pipeline started.\n");
      return 0;
    }
    if (argv.length === 0) {
      const workerEnv = environment ?? { ...process.env };
      if (environment === undefined) loadRootEnv({ processEnv: workerEnv });
      const { state, publication } = await productionRunner({ root, workerEnv, signal: controller.signal });
      stdout.write(`Daily: ${state.runId} ${state.status}; publication ${publication?.committed ? "committed" : "not committed"}.\n`);
      if (publication?.bookkeeping === "pending") stderr.write("Publication committed; bookkeeping pending. Use --recover-lock to reconcile.\n");
      return state.status === "succeeded" ? 0 : state.status === "succeeded_degraded" ? 2 : 1;
    }
    const { state } = await runDaily({ root, stages: [{ id: "foundation", moduleUrl: null }], signal: controller.signal });
    stdout.write(`Foundation self-test only: ${state.runId} ${state.status}; no edition produced.\n`);
    return ["succeeded", "succeeded_degraded"].includes(state.status) ? 0 : 1;
  } catch {
    stderr.write("Daily execution needs attention; inspect current.json and run state/lock. The verified current pointer is publication truth.\n");
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runDailyCli();
