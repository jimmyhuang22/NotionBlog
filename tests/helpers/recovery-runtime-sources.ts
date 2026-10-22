import assert from "node:assert/strict";
import { checkCaptureReleaseCompatibility } from "../../scripts/website-sync/capture-release-compatibility.ts";

// New source candidate is deliberately outside every frozen historical transition.
export const recoveryRuntimeSources = [
  {
    "path": "scripts/website-sync/collection-revalidation.ts",
    "sha256": "130ed9a13eb443f78866f0b74683834ed2747a9312dfb0c4d3993ff494492085"
  },
  {
    "path": "scripts/website-sync/run-private.mjs",
    "sha256": "551f03a761dd0f6055e2bead779fc95fb7bffc246bd850e68763571c6024f146"
  },
  {
    "path": "scripts/website-sync/run.ts",
    "sha256": "36850d3e4d2fb499209dd77c2b60b6c2d4757833d9ed6b8a60ae8474075a471e"
  },
  {
    "path": "scripts/check-website-protocol.ts",
    "sha256": "8f0c79fc2808d7af5ff4425737ccdcb96bab7932925c8a1d55c6bd19f68dcaab"
  }
] as const;
export function laterRecoveryRuntime(path: string, current: string, prior: string,
  producer: Parameters<typeof checkCaptureReleaseCompatibility>[0], consumer: Parameters<typeof checkCaptureReleaseCompatibility>[1]): boolean {
  const file = recoveryRuntimeSources.find(file => file.path === path);
  if (!file || current === prior) return false;
  assert.equal(current, file.sha256, path);
  const changed = structuredClone(consumer);
  changed.files.find(file => file.path === path)!.sha256 = current;
  assert.throws(() => checkCaptureReleaseCompatibility(producer, changed), { code: "RELEASE_INVALID" });
  return true;
}
