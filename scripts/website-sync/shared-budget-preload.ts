import { openSharedBudget } from "./shared-budget.ts";
import { installSharedTransports } from "./shared-budget-transport.ts";

// The verified host forwards only this context, not NODE_OPTIONS or private
// shell variables. Failure here happens before run.ts or session code loads.
try {
  const e = process.env;
  if (e.WEBSITE_PARENT_PID !== String(process.ppid)) throw new Error();
  const budget = openSharedBudget({ directory: e.WEBSITE_SHARED_BUDGET_DIRECTORY ?? "", planDigest: e.WEBSITE_SHARED_BUDGET_DIGEST ?? "",
    nonce: e.WEBSITE_SHARED_BUDGET_NONCE ?? "", runtimeSha256: e.WEBSITE_SHARED_BUDGET_RUNTIME_SHA256 ?? "" });
  if (budget.plan.parentPid !== process.ppid) throw new Error();
  const transport = installSharedTransports(budget); transport.guard();
  // run.ts closes/drains its pools before Node beforeExit. Preserve charges
  // until all tracked response bodies/callbacks settle; never run another job.
  process.once("beforeExit", () => { void transport.drain().finally(() => transport.restore()); });
} catch {
  console.error(JSON.stringify({ outcome: "preparation-failed", code: "SHARED_BUDGET_PRELOAD_INVALID" })); process.exit(1);
}
