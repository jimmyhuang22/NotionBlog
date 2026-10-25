import { checkReaderIsolationRelease } from "../src/server/database/reader-isolation-release.ts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: node scripts/check-reader-isolation-release.ts --phase deferred|verified --mode unset|off|enforce [--evidence-sha256 SHA256]\nChecks only the supplied declaration; no environment, evidence file, database or deployment is read.");
} else {
  try {
    const values: Record<string, string> = {}, names: Record<string, string> = {
      "--phase": "phase", "--mode": "mode", "--evidence-sha256": "evidenceSHA256",
    };
    if (args.length !== 4 && args.length !== 6) throw new Error();
    for (let i = 0; i < args.length; i += 2) {
      const key = names[args[i]];
      if (!Object.hasOwn(names, args[i]) || Object.hasOwn(values, key) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error();
      values[key] = args[i + 1];
    }
    console.log(JSON.stringify(checkReaderIsolationRelease(values)));
  } catch {
    console.error("READER_ISOLATION_RELEASE_INVALID"); process.exitCode = 2;
  }
}
