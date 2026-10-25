/**
 * Console settings, read from the environment of the process that runs it (see console/README.md).
 * Kept free of Next and server-only imports so the proxy, the run script's checks and tests share it.
 */
import type { BridgeOptions } from "./bridge-backend.ts";

export interface ConsoleConfig {
  backend: "demo" | "bridge";
  bridge: BridgeOptions | null;
  /** Null: no login (demo only). */
  password: string | null;
  sessionSecret: string | null;
  /** Host names the console answers to; anything else is refused (guards against DNS rebinding). */
  allowedHosts: string[];
  /** Where page links point, such as the live site; null shows paths as plain text. */
  siteOrigin: string | null;
  timeZone: string;
}

export type ConfigResult = { ok: true; config: ConsoleConfig } | { ok: false; error: string };

const localHosts = ["localhost", "127.0.0.1", "[::1]", "::1"];

export function readConfig(env: Record<string, string | undefined>): ConfigResult {
  const backend = (env.CONSOLE_BACKEND ?? "demo").trim();
  if (backend !== "demo" && backend !== "bridge") return { ok: false, error: "CONSOLE_BACKEND must be demo or bridge." };

  const password = env.CONSOLE_PASSWORD?.length ? env.CONSOLE_PASSWORD : null;
  const sessionSecret = env.CONSOLE_SESSION_SECRET?.length ? env.CONSOLE_SESSION_SECRET : null;
  if (password !== null && password.length < 12) return { ok: false, error: "CONSOLE_PASSWORD must be at least 12 characters." };
  if (password !== null && (sessionSecret === null || sessionSecret.length < 32)) {
    return { ok: false, error: "CONSOLE_SESSION_SECRET (at least 32 characters) is required with a password." };
  }

  let bridge: BridgeOptions | null = null;
  if (backend === "bridge") {
    if (password === null) return { ok: false, error: "The bridge backend needs CONSOLE_PASSWORD and CONSOLE_SESSION_SECRET." };
    const command = env.CONSOLE_BRIDGE_COMMAND?.trim() ?? "";
    if (!command.startsWith("/")) return { ok: false, error: "CONSOLE_BRIDGE_COMMAND must be an absolute path." };
    let args: string[] = [];
    if (env.CONSOLE_BRIDGE_ARGS_JSON) {
      try {
        const parsed: unknown = JSON.parse(env.CONSOLE_BRIDGE_ARGS_JSON);
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error();
        args = parsed;
      } catch {
        return { ok: false, error: "CONSOLE_BRIDGE_ARGS_JSON must be a JSON array of strings." };
      }
    }
    bridge = { command, args };
  }

  const extraHosts = (env.CONSOLE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (extraHosts.some((host) => host.includes("/") || host.includes(":") && !host.startsWith("["))) {
    return { ok: false, error: "CONSOLE_ALLOWED_HOSTS lists host names only, without ports or paths." };
  }

  let siteOrigin: string | null = null;
  if (env.CONSOLE_SITE_ORIGIN) {
    try {
      const url = new URL(env.CONSOLE_SITE_ORIGIN);
      if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error();
      siteOrigin = url.origin;
    } catch {
      return { ok: false, error: "CONSOLE_SITE_ORIGIN must be an https origin." };
    }
  }

  const timeZone = env.CONSOLE_TIME_ZONE?.trim() || "Australia/Melbourne";
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone });
  } catch {
    return { ok: false, error: "CONSOLE_TIME_ZONE is not a known time zone." };
  }

  return {
    ok: true,
    config: { backend, bridge, password, sessionSecret, allowedHosts: [...localHosts, ...extraHosts], siteOrigin, timeZone },
  };
}

/** The host name of a Host header, lower-cased and without the port. */
export function hostName(header: string | null): string | null {
  if (!header) return null;
  const value = header.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(0, end + 1) : null;
  }
  return value.split(":")[0] || null;
}
