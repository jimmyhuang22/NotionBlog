import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const cli = new URL("../../scripts/media-thumbnails/cli.ts", import.meta.url);
// With this helper as argv[1], importing the CLI only loads its modules.
// The second module evaluation below executes its unchanged real entry point.
await import(cli.href);
// Observe the actual timers requested by the real entry point. Parent-side IPC/exit
// scheduling can be delayed on the shared runner; it is not the command's deadline.
const timingFile = process.env.THUMBNAIL_TEST_TIMING_FILE;
if (timingFile) {
  const timers: number[] = [], native = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timers.push(args[1] ?? 0);
    writeFileSync(timingFile, JSON.stringify(timers), { mode: 0o600 });
    return native(...args);
  }) as typeof setTimeout;
}
process.once("message", (args: unknown) => {
  if (!Array.isArray(args) || args.some(value => typeof value !== "string")) {
    process.disconnect?.(); process.exitCode = 2; return;
  }
  process.argv = [process.execPath, fileURLToPath(cli), ...args];
  process.disconnect?.();
  cli.search = "?cli-test-entry";
  void import(cli.href).catch(() => { process.exitCode = 2; });
});
process.send?.({ ready: true });
