import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ContentKind } from "../../contracts/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { createWebsiteDatabaseRepository } from "../../src/server/database/website-repository.ts";
import { WorkerError } from "../notion-sync/errors.ts";
import { privateDirectory } from "../notion-sync/state.ts";

// Only kinds considered by the existing thumbnail selector. Study/About bodies
// are not needed for its coverage plan. Source eligibility still comes from SQL.
const KINDS: ContentKind[] = ["status", "album", "book", "movie", "game", "post", "project", "course"];
const MAX_BYTES = 32 * 1024 * 1024;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const directoryName = "thumbnail-handoff";
const snapshotName = "snapshot-private.json";
const manifestName = "handoff-private.json";

export interface PublicationHandoffReference {
  manifest: string;
  snapshot: string;
  snapshotVersion: string;
  snapshotSha256: string;
  records: number;
}

async function atomicFile(directory: string, name: string, text: string): Promise<void> {
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, join(directory, name));
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Private planning input, not a grant to read, upload or register thumbnails. */
export async function exportPublicationHandoff(input: {
  db: SqlExecutor; output: string; runId: string; releaseCommit: string; sourceSha256: string;
  guard: () => void;
}): Promise<PublicationHandoffReference> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.runId) ||
      !/^[a-f0-9]{40}$/.test(input.releaseCommit) || !/^[a-f0-9]{64}$/.test(input.sourceSha256)) {
    throw new WorkerError("MISCONFIGURED");
  }
  input.guard();
  // Use the website projection, including current withdrawal scrubbing. Do not
  // export the worker's staged records or its raw Notion/source inputs.
  const snapshot = await createWebsiteDatabaseRepository(input.db).readSnapshot!(KINDS, true);
  if (!snapshot.version.startsWith(`${input.runId}:`) || !/^[0-9]+$/.test(snapshot.version.slice(37))) {
    throw new WorkerError("CHECKPOINT_FAILED");
  }
  const readerVerifiedAt = new Date().toISOString();
  const text = JSON.stringify(snapshot) + "\n";
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_BYTES) throw new WorkerError("CHECKPOINT_FAILED");
  input.guard();
  await privateDirectory(input.output);
  // A run gets one immutable bundle. Refuse to overwrite a previous handoff.
  const directory = join(input.output, directoryName);
  await mkdir(directory, { mode: 0o700 });
  await privateDirectory(directory);
  const reference: PublicationHandoffReference = {
    manifest: `${directoryName}/${manifestName}`, snapshot: `${directoryName}/${snapshotName}`,
    snapshotVersion: snapshot.version, snapshotSha256: hash(text), records: snapshot.records.length,
  };
  await atomicFile(directory, snapshotName, text);
  input.guard();
  // Commit marker is written last. A lone snapshot/temporary file is incomplete.
  await atomicFile(directory, manifestName, JSON.stringify({
    format: "notionblog-publication-thumbnail-handoff-v1", version: "v2", runId: input.runId,
    releaseCommit: input.releaseCommit, sourceSha256: input.sourceSha256, schemaDigest: WEBSITE_SCHEMA_DIGEST,
    readerVerifiedAt, qualification: "RECHECK_CURRENT_RUN_AND_SOURCES_BEFORE_EXECUTION", validUntil: null,
    snapshot: { file: snapshotName, version: snapshot.version, sha256: reference.snapshotSha256, bytes, records: reference.records },
  }, null, 2) + "\n");
  return reference;
}
