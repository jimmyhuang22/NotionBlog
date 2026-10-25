import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { WorkerError, checkSignal } from "./errors.ts";
import { privateDirectory } from "./state.ts";

/** A reviewed local ImageIO binary, compiled once; no shell, source URLs or credentials. */
export function createHeicConverter(options: { executable: string; temporaryRoot: string }) {
  return async (bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> => {
    checkSignal(signal);
    if (!isAbsolute(options.executable) || !isAbsolute(options.temporaryRoot)) throw new WorkerError("MISCONFIGURED");
    let directory: string | undefined;
    try {
      const file = await lstat(options.executable);
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o022) || !(file.mode & 0o100) ||
          file.uid !== process.getuid?.() || await realpath(options.executable) !== options.executable) throw new WorkerError("IMAGE_REJECTED");
      await privateDirectory(options.temporaryRoot);
      directory = await mkdtemp(join(options.temporaryRoot, "heic-"));
      const input = join(directory, "input.heic"), output = join(directory, "output.jpg");
      await writeFile(input, bytes, { mode: 0o600, flag: "wx" });
      checkSignal(signal);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(options.executable, [input, output], { cwd: directory,
          env: { PATH: "/usr/bin:/bin", TMPDIR: directory, NODE_ENV: "production" }, shell: false, stdio: "ignore" });
        const cancel = () => { child.kill("SIGKILL"); };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        child.once("error", () => { signal.removeEventListener("abort", cancel); reject(new WorkerError("IMAGE_UNAVAILABLE")); });
        child.once("close", code => {
          signal.removeEventListener("abort", cancel);
          if (signal.aborted) reject(new WorkerError("CANCELLED"));
          else if (code !== 0) reject(new WorkerError("IMAGE_UNAVAILABLE")); else resolve();
        });
      });
      checkSignal(signal);
      const result = await lstat(output);
      if (!result.isFile() || result.isSymbolicLink() || (result.mode & 0o777) !== 0o600 ||
          result.size < 1 || result.size > 20 * 1024 * 1024) throw new WorkerError("IMAGE_REJECTED");
      return await readFile(output);
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(signal.aborted ? "CANCELLED" : "IMAGE_UNAVAILABLE");
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  };
}
