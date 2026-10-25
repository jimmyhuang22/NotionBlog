import "server-only";
import { BridgeBackend } from "./bridge-backend.ts";
import { readConfig, type ConsoleConfig } from "./config.ts";
import { DemoBackend } from "./demo-backend.ts";
import type { ConsoleBackend } from "./types.ts";

interface Held {
  backend: ConsoleBackend;
  config: ConsoleConfig;
}

// Kept on globalThis so the demo's state survives module reloads during development.
const holder = globalThis as typeof globalThis & { __nbConsole?: Held };

export function consoleConfig(): ConsoleConfig {
  return held().config;
}

export function getBackend(): ConsoleBackend {
  return held().backend;
}

/** The demo backend, or null when the real one is in use. */
export function demoBackend(): DemoBackend | null {
  const backend = held().backend;
  return backend instanceof DemoBackend ? backend : null;
}

function held(): Held {
  if (holder.__nbConsole) return holder.__nbConsole;
  const result = readConfig(process.env);
  if (!result.ok) throw new Error(result.error);
  const { config } = result;
  const backend: ConsoleBackend = config.backend === "bridge" && config.bridge ? new BridgeBackend(config.bridge) : new DemoBackend();
  holder.__nbConsole = { backend, config };
  return holder.__nbConsole;
}
