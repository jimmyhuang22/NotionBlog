import assert from "node:assert/strict";
import { checkCaptureReleaseCompatibility } from "../../scripts/website-sync/capture-release-compatibility.ts";

/** New full-collection bytes. This list grants NO historical capture compatibility. */
export const zeroRetryRuntimeSources: Record<string, string> = {
  "src/server/database/connection.ts": "2c55b08ca16f3a4201a8f83020946bd61c6b0e034405e76e391c2e0eda6846fc",
  "scripts/notion-sync/download.ts": "b9f6611595ae9da60931c67d843464fc2b3c87e05626a14fdb8e796c6e34c010",
  "scripts/website-sync/download.ts": "c200efd3effc0c8daa54fe44d30cab0a9d2d54ade556f6e95fac52789f7fa5dc",
  "scripts/website-sync/run.ts": "bda4cb6557361df1f83bc75e4a248012fe05e40b4c0ebd0ecb7a1dfc7ef54994",
  "scripts/website-sync/runtime-reader.ts": "7f721aced3478b327cb3852238adb4046ce338398b72122e1afe4925c33e0672",
  "scripts/website-sync/runtime-sql.ts": "3331b1e4a1a0ee2f1839ce5eea49c6883efde54c8282d7a191e175874020e83e",
  "scripts/website-sync/worker.ts": "97f5fb9af41ee0018df2ac0bb65f262ed34d26956bd6c4a07b6873dd12e90ba6",
  "src/server/notion/client.ts": "1c3cbae1fa6f16b9d85b70e0a67c7e954e0ca70d13efcdfa4cdaf001f4a7f82f"
};
export function laterZeroRetryRuntime(path: string, current: string, prior: string,
  producer: Parameters<typeof checkCaptureReleaseCompatibility>[0], consumer: Parameters<typeof checkCaptureReleaseCompatibility>[1]): boolean {
  const expected = zeroRetryRuntimeSources[path];
  if (!expected || current === prior) return false;
  assert.equal(current, expected, path);
  const changed = structuredClone(consumer);
  changed.files.find(file => file.path === path)!.sha256 = current;
  assert.throws(() => checkCaptureReleaseCompatibility(producer, changed), { code: "RELEASE_INVALID" });
  return true;
}
