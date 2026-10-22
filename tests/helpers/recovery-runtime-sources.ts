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
    "sha256": "94097d3954cf59bdf2e5030cbe4a91e12305c999e34229c3b356fe0c7d4cea9d"
  },
  {
    "path": "scripts/website-sync/run.ts",
    "sha256": "f896668b5d7a9241ac53caebf8dc3f699ae98c53dd7e29c7908218f047132370"
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
