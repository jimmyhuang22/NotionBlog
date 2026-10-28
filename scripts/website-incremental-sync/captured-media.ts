import type { StoredMedia } from "../../contracts/sync.ts";
import { validateMedia } from "../../src/server/database/website-validation.ts";
import { verifyMediaBytes, type ObjectStorage } from "../../src/server/database/storage.ts";

export interface CapturedMediaEvent {phase: "sending" | "stored" | "unconfirmed" | "not-sent"; objectKey: string; sha256: string; byteSize: number; acknowledged?: boolean}
function fail(code: string): never { throw Object.assign(Error(code), {code}); }
/** Copy already captured immutable bytes. Never resolves a source URL, collects
 * content, publishes SQL, retries a PUT or changes a media binding. Caller
 * supplies the existing lock and durable operation journal. */
export async function copyCapturedMedia(options: {
  media: readonly StoredMedia[]; maxBytes: number;
  readLocal(media: StoredMedia): Promise<Uint8Array>;
  storage: Pick<ObjectStorage, "put">;
  record(event: CapturedMediaEvent): Promise<void>;
}, signal: AbortSignal) {
  if (!Array.isArray(options.media) || options.media.length > 20000 || !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 || options.maxBytes > 2 * 1024 ** 3) fail("CAPTURE_MEDIA_INPUT_INVALID");
  const objects = new Map<string, StoredMedia>();
  for (const original of options.media) {
    const media = structuredClone(original); validateMedia(media);
    const previous = objects.get(media.objectKey);
    if (previous && (previous.sha256 !== media.sha256 || previous.byteSize !== media.byteSize || previous.mime !== media.mime)) fail("CAPTURE_MEDIA_DESCRIPTOR_CONFLICT");
    objects.set(media.objectKey, media);
  }
  const bytes = [...objects.values()].reduce((n, media) => n + media.byteSize, 0);
  if (bytes > options.maxBytes) fail("CAPTURE_MEDIA_BUDGET_EXCEEDED");
  let copied = 0;
  for (const media of objects.values()) {
    signal.throwIfAborted(); const data = await options.readLocal(media); signal.throwIfAborted();
    verifyMediaBytes(media, data);
    const entry = {objectKey: media.objectKey, sha256: media.sha256, byteSize: media.byteSize};
    // Must finish persisting this intent before the first possible remote write.
    await options.record({...entry, phase: "sending"});
    if (signal.aborted) {await options.record({...entry, phase: "not-sent"}); signal.throwIfAborted();}
    let acknowledged = false;
    try {
      await options.storage.put(media, data); acknowledged = true;
      await options.record({...entry, phase: "stored"}); copied++;
    } catch {
      try { await options.record({...entry, phase: "unconfirmed", acknowledged}); } catch { /* Durable sending intent remains. */ }
      fail(acknowledged ? "CAPTURE_MEDIA_RECEIPT_UNSAVED" : "CAPTURE_MEDIA_OUTCOME_UNKNOWN");
    }
  }
  return {objects: copied, bytes};
}
