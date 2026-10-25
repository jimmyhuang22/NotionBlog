#!/usr/bin/env node
/**
 * Starts the console: `node console/run.mjs [dev|build|start] [--port 4310]`.
 *
 * It listens on 127.0.0.1 unless CONSOLE_HOST names another address (such as the Mac mini's
 * Tailscale address). Wildcard addresses are refused so the console never answers on every network.
 * Settings come from the environment; load a private file with `node --env-file=… console/run.mjs`.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./lib/config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const command = ["dev", "build", "start"].includes(args[0]) ? args.shift() : "dev";

let port = process.env.CONSOLE_PORT ?? "4310";
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--port" || args[index] === "-p") port = args[++index] ?? port;
  else {
    console.error(`Unknown option: ${args[index]}`);
    process.exit(2);
  }
}
if (!/^\d{2,5}$/.test(port)) {
  console.error("The port must be a number.");
  process.exit(2);
}

const host = (process.env.CONSOLE_HOST ?? "127.0.0.1").trim();
if (["0.0.0.0", "::", "[::]", ""].includes(host)) {
  console.error("Refusing to listen on every network. Set CONSOLE_HOST to 127.0.0.1 or the Tailscale address.");
  process.exit(2);
}

const result = readConfig(process.env);
if (!result.ok) {
  console.error(`Console configuration: ${result.error}`);
  process.exit(2);
}
if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && result.config.password === null) {
  console.error("Listening beyond this machine needs CONSOLE_PASSWORD and CONSOLE_SESSION_SECRET.");
  process.exit(2);
}

// A kept development cache can make next dev reload forever; start clean.
if (command === "dev") rmSync(path.join(here, ".next", "dev"), { recursive: true, force: true });

// Run Next's own script with this Node, so the console starts the same way under launchd, where
// PATH holds no node for the .bin shim's `#!/usr/bin/env node`.
const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
const nextArgs = command === "build" ? ["build", here] : [command, here, "--hostname", host, "--port", port];
const child = spawn(process.execPath, [next, ...nextArgs], { cwd: root, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
