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
    "sha256": "d3fb87d4a114e27ba52553f79c57a5903627f57659aef392b260aa005695a99f"
  },
  {
    "path": "scripts/website-sync/run.ts",
    "sha256": "f2940cbd2f1dc190443d5da71a1ff542fb2dbca337525cabbc0c6378b24d1e52"
  },
  {
    "path": "scripts/check-website-protocol.ts",
    "sha256": "8f0c79fc2808d7af5ff4425737ccdcb96bab7932925c8a1d55c6bd19f68dcaab"
  },
  {
    "path": "scripts/website-sync/collection-resume-plan.ts",
    "sha256": "cd96627f5b8e1aa75acd302c99be6e413faaba2610187a5b2d6f73c8c50b2b52"
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
