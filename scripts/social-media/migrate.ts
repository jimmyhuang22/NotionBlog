import { createHash } from "node:crypto";
import type { StoredMedia } from "../../contracts/sync.ts";
import { validateMedia } from "../../src/server/database/validation.ts";
import { verifyMediaBytes, type ObjectStorage } from "../../src/server/database/storage.ts";

export interface CoverCopyReceipt {
  inputSha256: string;
  verified: Record<string, { sha256: string; byteSize: number }>;
  inFlight: { sha256: string; phase: "put" | "readback" } | null;
  status: "RUNNING" | "PASS" | "STOPPED";
}
/** Copies verified local files only. No source collection, encoding, metadata registration or deletion. */
export async function copyCoverObjects(inputs: StoredMedia[], ports: {
  local(media: StoredMedia): Promise<Uint8Array>;
  target: ObjectStorage;
  save(receipt: CoverCopyReceipt): Promise<void>;
  previous?: CoverCopyReceipt;
  signal: AbortSignal;
}, limits: { objects: number; bytes: number }): Promise<CoverCopyReceipt> {
  if (!Number.isSafeInteger(limits.objects) || limits.objects < 1 || limits.objects > 2000 ||
      !Number.isSafeInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > 256 * 1024 * 1024) throw Error("COPY_LIMIT_INVALID");
  const unique = new Map<string, StoredMedia>();
  for (const input of inputs) {
    const media = { ...input }; validateMedia(media);
    const old = unique.get(media.sha256);
    if (old && (old.objectKey !== media.objectKey || old.byteSize !== media.byteSize || old.mime !== media.mime)) throw Error("COPY_DESCRIPTOR_CONFLICT");
    unique.set(media.sha256, old ?? media);
  }
  // Exercise the slowest transfers first, rather than discovering a size problem after hundreds of files.
  const files = [...unique.values()].sort((a, b) => b.byteSize - a.byteSize || a.sha256.localeCompare(b.sha256));
  if (files.length > limits.objects || files.reduce((sum, file) => sum + file.byteSize, 0) > limits.bytes) throw Error("COPY_LIMIT_EXCEEDED");
  const inputSha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const receipt: CoverCopyReceipt = ports.previous ? structuredClone(ports.previous) : { inputSha256, verified: {}, inFlight: null, status: "RUNNING" };
  if (receipt.inputSha256 !== inputSha256 || Object.keys(receipt.verified).some(sha => !unique.has(sha))) throw Error("COPY_RECEIPT_MISMATCH");
  if (receipt.inFlight && (!unique.has(receipt.inFlight.sha256) || !["put", "readback"].includes(receipt.inFlight.phase))) throw Error("COPY_RECEIPT_MISMATCH");
  receipt.status = "RUNNING";
  try {
    for (const file of files) {
      ports.signal.throwIfAborted();
      const proved = receipt.verified[file.sha256];
      if (proved) {
        if (proved.sha256 !== file.sha256 || proved.byteSize !== file.byteSize) throw Error("COPY_PROOF_INVALID");
        continue;
      }
      const bytes = await ports.local(file); verifyMediaBytes(file, bytes);
      // An interrupted PUT is read back before it can ever be sent again.
      if (receipt.inFlight?.sha256 === file.sha256) {
        receipt.inFlight.phase = "readback"; await ports.save(structuredClone(receipt));
        verifyMediaBytes(file, await ports.target.read(file));
      } else {
        receipt.inFlight = { sha256: file.sha256, phase: "put" }; await ports.save(structuredClone(receipt));
        await ports.target.put(file, bytes);
        receipt.inFlight.phase = "readback"; await ports.save(structuredClone(receipt));
        verifyMediaBytes(file, await ports.target.read(file));
      }
      ports.signal.throwIfAborted();
      receipt.verified[file.sha256] = { sha256: file.sha256, byteSize: file.byteSize };
      receipt.inFlight = null; await ports.save(structuredClone(receipt));
    }
    receipt.status = "PASS"; await ports.save(structuredClone(receipt)); return receipt;
  } catch (error) {
    receipt.status = "STOPPED"; await ports.save(structuredClone(receipt)); throw error;
  }
}
