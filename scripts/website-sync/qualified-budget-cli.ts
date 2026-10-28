import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { initializeSharedBudget, openSharedBudget, validateSharedPlan, budgetFail, SharedBudgetError, type SharedLimits } from "./shared-budget.ts";
import { installSharedTransports } from "./shared-budget-transport.ts";
import type { FullCollectionContextOwner } from "./run-private.mjs";

interface BudgetInput { format: "qualified-budget-input-v1"; runtimeSha256: string; storageOrigin: string; durationMs: number; cleanupMs: number; limits: SharedLimits }
export function parseQualifiedBudgetInput(value: unknown): BudgetInput {
  const b = value as BudgetInput;
  if (!b || Object.keys(b).length !== 6 || b.format !== "qualified-budget-input-v1" || !Number.isSafeInteger(b.durationMs) || b.durationMs < 10 || b.durationMs > 10800000) budgetFail("SHARED_BUDGET_INPUT_INVALID");
  validateSharedPlan({ format: "qualified-shared-budget-v1", parentPid: process.pid, nonce: randomUUID(), deadline: Date.now() + b.durationMs,
    cleanupMs: b.cleanupMs, runtimeSha256: b.runtimeSha256, storageOrigin: b.storageOrigin, limits: b.limits });
  return b;
}
export async function qualifiedBudgetMain(args: readonly string[], ports: { ownerMetadata?: FullCollectionContextOwner; nativeChildContext?: {file:string;sha256:string;preload:string;preloadSHA256:string} } = {}) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/website-sync/qualified-budget-cli.ts --config PRIVATE_RUNTIME --budget PRIVATE_BUDGET --ledger FRESH_PRIVATE_DIRECTORY --mode dry-run|stage|publish [--check|--execute]\nDefault: offline check. Execute runs exactly one original qualified host job, with a shared durable parent/child budget. No policy setup, installation or automatic retry."); return 0;
  }
  const { values } = parseArgs({ args: [...args], options: { config: { type: "string" }, budget: { type: "string" }, ledger: { type: "string" }, mode: { type: "string" }, check: { type: "boolean" }, execute: { type: "boolean" } }, strict: true, allowPositionals: false });
  if (!values.config || !values.budget || !values.ledger || !["dry-run", "stage", "publish"].includes(values.mode ?? "") || values.check && values.execute ||
      resolve(values.ledger) !== values.ledger) budgetFail("SHARED_BUDGET_INPUT_INVALID");
  // Private file/release checks are the original host's checks. No credentials
  // are copied to a new config, and the canonical locks still belong to it.
  const { privateText, directory } = await import("./release.mjs");
  await directory(dirname(values.budget)); await directory(dirname(values.ledger));
  const input = parseQualifiedBudgetInput(JSON.parse(await privateText(values.budget)));
  const { runPrivateWebsiteWorker } = await import("./run-private.mjs");
  const sharedBudget = { runtimeSha256: input.runtimeSha256, storageOrigin: input.storageOrigin };
  const checked = await runPrivateWebsiteWorker({ configFile: values.config, mode: values.mode, check: true, sharedBudget });
  if (checked.resumePlan && input.limits.notionRequests < checked.resumePlan.requestReserve) budgetFail("SHARED_BUDGET_INPUT_INVALID");
  if (!values.execute) {
    console.log(JSON.stringify({ adapter: "qualified-shared-budget-v1", offlineCheck: true, workerStarted: false, networkChecked: false, releaseCommit: checked.releaseCommit, resumePlan: checked.resumePlan, fullCollectionPlan: checked.fullCollectionPlan })); return 0;
  }
  if (checked.fullCollectionPlan && (typeof ports.ownerMetadata !== "function" || !ports.nativeChildContext)) budgetFail("SHARED_BUDGET_INPUT_INVALID");
  const bridge = initializeSharedBudget(values.ledger, { format: "qualified-shared-budget-v1", parentPid: process.pid, nonce: randomUUID(),
    deadline: Date.now() + input.durationMs, cleanupMs: input.cleanupMs, runtimeSha256: input.runtimeSha256, storageOrigin: input.storageOrigin, limits: input.limits });
  const budget = openSharedBudget(bridge), transport = installSharedTransports(budget);
  try {
    transport.guard();
    const result = await runPrivateWebsiteWorker({ configFile: values.config, mode: values.mode, sharedBudget: { ...sharedBudget, bridge }, ownerMetadata: ports.ownerMetadata, nativeChildContext: ports.nativeChildContext });
    const failedBudget = !!budget.read().failure;
    console.log(JSON.stringify({ adapter: "qualified-shared-budget-v1", outcome: result.outcome, published: result.published,
      readerVerified: result.readerVerified, publicationMayHaveCommitted: result.publicationMayHaveCommitted,
      requiresReceiptCheck: result.requiresReceiptCheck || failedBudget, exitCode: failedBudget ? 1 : result.exitCode }));
    return failedBudget ? 1 : result.exitCode ?? 1;
  } finally {
    await transport.drain();
    try { const { counters, failure } = budget.read(); console.log(JSON.stringify({ format: "qualified-shared-budget-receipt-v1", counters, failure })); }
    finally { transport.restore(); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) qualifiedBudgetMain(process.argv.slice(2))
  .then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ outcome: "failed", code: error instanceof SharedBudgetError ? error.code : "QUALIFIED_HOST_UNAVAILABLE" })); process.exitCode = 1;
  });
