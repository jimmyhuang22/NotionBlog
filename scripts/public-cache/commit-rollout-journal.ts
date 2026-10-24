import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "../notion-sync/state.ts";
import { privateCachePath } from "./local.ts";
import type { CommitRolloutReport } from "./commit-rollout.ts";

/** Immutable records and one exclusive nonce/operation claim. Never removes or
 * overwrites a partial record after an uncertain write, and never reopens a run. */
export async function createCommitRolloutJournal(root: string, operation: string) {
  privateCachePath(root);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operation)) throw Error("CACHE_ROLLOUT_JOURNAL_INPUT");
  await privateDirectory(root);
  const originalRoot = await lstat(root), directory = join(root, `operation-${operation}`);
  let originalDirectory: Stats | undefined, claimed = false, sequence = 0;
  const assertDirectory = async (path: string, original: typeof originalRoot) => {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.mode & 0o077 || current.dev !== original.dev || current.ino !== original.ino ||
        (process.getuid && current.uid !== process.getuid()) || await realpath(path) !== path) throw Error("CACHE_ROLLOUT_JOURNAL_DIRECTORY");
  };
  const syncDirectory = async (path: string) => { const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } };
  const create = async (path: string, data: unknown) => {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(data) + "\n"); await handle.sync(); } finally { await handle.close(); }
  };
  return {
    claim: async (nonce: string, planSHA256: string) => {
      if (claimed || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(planSHA256)) throw Error("CACHE_ROLLOUT_JOURNAL_CLAIM");
      await assertDirectory(root, originalRoot);
      await create(join(root, `nonce-${nonce}.json`), { version: 1, nonce, operation, planSHA256 });
      await assertDirectory(root, originalRoot);
      await syncDirectory(root);
      await mkdir(directory, { mode: 0o700 }); originalDirectory = await lstat(directory);
      await assertDirectory(directory, originalDirectory); await syncDirectory(root); claimed = true;
    },
    save: async (report: CommitRolloutReport) => {
      if (!claimed || !originalDirectory || report.operation !== operation || sequence >= 9999 ||
          !["install", "enable", "disable"].includes(report.action) || !["not-started", "rolled-back", "unknown", "committed"].includes(report.outcome) ||
          !["claim", "fence", "mutation-intent", "commit-intent", "committed", "verified"].includes(report.stage) ||
          [report.verified, report.connectionClosed, report.holdReleased, report.journalFailed].some(v => typeof v !== "boolean") ||
          [report.connections, report.driverCalls, report.logicalBytes].some(v => !Number.isSafeInteger(v) || v < 0) ||
          (report.error !== null && !/^CACHE_ROLLOUT_[A-Z_]+$/.test(report.error))) throw Error("CACHE_ROLLOUT_JOURNAL_INPUT");
      await assertDirectory(root, originalRoot); await assertDirectory(directory, originalDirectory);
      const { action, outcome, stage, verified, connectionClosed, holdReleased, journalFailed, connections, driverCalls, logicalBytes, error } = report;
      await create(join(directory, `step-${String(++sequence).padStart(4, "0")}.json`), { version: 1, operation, action, outcome, stage, verified, connectionClosed, holdReleased, journalFailed, connections, driverCalls, logicalBytes, error });
      await syncDirectory(directory);
      await assertDirectory(root, originalRoot); await assertDirectory(directory, originalDirectory);
    },
  };
}
