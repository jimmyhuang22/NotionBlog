import assert from "node:assert/strict";
import { checkCaptureReleaseCompatibility } from "../../scripts/website-sync/capture-release-compatibility.ts";

// Game artwork and playtime change the producer bytes. Historical captures
// must still reject the current mapper and worker; these are test pins only.
export const gameCaseRuntime: Readonly<Record<string, string>> = {
  "scripts/website-sync/worker.ts": "eaba75fa41d6799ca627ffcc58c47336209963bb7a362dc51c975da95bafbfbf",
  "src/server/notion/blocks.ts": "8e8547c2223c6112fdec2190680e39e2bfae1a30249a26da1b615eabf6c9b91e",
  "src/server/notion/website-repository.ts": "b1c8b5430df15def227707fe521404887981efe77f42aabc9c3fb1379763bf71",
};
export function laterGameCaseRuntime(path: string, current: string, prior: string,
  producer: Parameters<typeof checkCaptureReleaseCompatibility>[0], consumer: Parameters<typeof checkCaptureReleaseCompatibility>[1]): boolean {
  if (!gameCaseRuntime[path] || current === prior) return false;
  assert.equal(current, gameCaseRuntime[path], path);
  const changed = structuredClone(consumer);
  changed.files.find(file => file.path === path)!.sha256 = current;
  assert.throws(() => checkCaptureReleaseCompatibility(producer, changed), { code: "RELEASE_INVALID" });
  return true;
}
