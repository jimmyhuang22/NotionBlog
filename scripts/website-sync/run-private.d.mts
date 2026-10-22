import type { BudgetBridge } from "./shared-budget.ts";
export function runPrivateWebsiteWorker(options: { configFile: string; mode?: string; check?: boolean;
  sharedBudget?: { runtimeSha256: string; storageOrigin: string; bridge?: BudgetBridge } }): Promise<{
    resumePlan?: ReturnType<typeof import("./collection-resume-plan.ts").collectionResumePlan> & {requestReserve:number;postSeconds:number};
    releaseCommit?: string; outcome?: string; published?: boolean; readerVerified?: boolean;
    requiresReceiptCheck?: boolean; publicationMayHaveCommitted?: boolean; exitCode?: number;
  }>;
