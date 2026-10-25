import { websiteReaderIsolationMode, type WebsiteReaderIsolationMode } from "./website-reader-isolation.ts";

export class ReaderIsolationReleaseError extends Error {
  readonly code = "READER_ISOLATION_RELEASE_INVALID";
  constructor() { super("The reader isolation release declaration is invalid."); }
}
function invalid(): never { throw new ReaderIsolationReleaseError(); }

/** Declaration consistency only: never loads credentials, reads evidence or verifies a live database. */
export function checkReaderIsolationRelease(input: unknown): { phase: "deferred" | "verified"; mode: WebsiteReaderIsolationMode } {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  if (value.phase !== "deferred" && value.phase !== "verified") invalid();
  if (typeof value.mode !== "string" || !["unset", "off", "enforce"].includes(value.mode)) invalid();
  const keys = value.phase === "deferred" ? ["mode", "phase"] : ["evidenceSHA256", "mode", "phase"];
  if (Object.keys(value).sort().join() !== keys.join()) invalid();
  const mode = websiteReaderIsolationMode(value.mode === "unset" ? undefined : value.mode);
  if (value.phase === "deferred" && mode !== "off" || value.phase === "verified" && mode !== "enforce") invalid();
  if (value.phase === "verified" && (typeof value.evidenceSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(value.evidenceSHA256))) invalid();
  return { phase: value.phase, mode };
}
