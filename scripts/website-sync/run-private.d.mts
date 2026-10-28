import type { BudgetBridge } from "./shared-budget.ts";
import type { OpenFullCollectionOwner } from "./full-collection-owner.ts";
import type { FullCollectionPlan, FullCollectionBinding, FullCollectionPrepared } from "./full-collection-control.ts";
export type FullCollectionContextOwner = (signal: AbortSignal, context: {prepared: FullCollectionPrepared; sourceOutput: string}) => ReturnType<OpenFullCollectionOwner>;
export function runPrivateWebsiteWorker(options: { configFile: string; mode?: string; check?: boolean;
  ownerMetadata?: FullCollectionContextOwner;
  nativeChildContext?: {file:string;sha256:string;preload:string;preloadSHA256:string};
  sharedBudget?: { runtimeSha256: string; storageOrigin: string; bridge?: BudgetBridge } }): Promise<{
    resumePlan?: ReturnType<typeof import("./collection-resume-plan.ts").collectionResumePlan> & {requestReserve:number;postSeconds:number};
    fullCollectionPlan?: FullCollectionPlan; fullCollectionBinding?: FullCollectionBinding;
    releaseCommit?: string; outcome?: string; published?: boolean; readerVerified?: boolean;
    requiresReceiptCheck?: boolean; publicationMayHaveCommitted?: boolean; exitCode?: number;
  }>;
