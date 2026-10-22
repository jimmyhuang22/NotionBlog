import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isClient = (source: string) => /^\s*["']use client["']/u.test(source);

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/u.test(name) ? [path] : [];
  });
}

function target(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join(root, "src", specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null;
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find(path => existsSync(path) && statSync(path).isFile()) ?? null;
}

/**
 * A server file may take components from a "use client" file, nothing else. A plain value taken from
 * one (the pre-paint theme script was) reaches the browser as a reference to that file's code; the
 * element using it then waits for the code while the page hydrates, and hydration failed now and then.
 */
test("server files import only components from client files", () => {
  const offences: string[] = [];
  for (const file of sources(join(root, "src", "app"))) {
    const source = readFileSync(file, "utf8");
    if (isClient(source)) continue;
    for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/gu)) {
      if (match[1]) continue;
      const path = target(file, match[3]!);
      if (!path || !isClient(readFileSync(path, "utf8"))) continue;
      for (const part of match[2]!.split(",").map(name => name.trim()).filter(Boolean)) {
        if (part.startsWith("type ")) continue;
        const name = part.split(/\s+as\s+/u)[0]!;
        if (!/^[A-Z]/u.test(name)) offences.push(`${file.slice(root.length + 1)} takes "${name}" from ${path.slice(root.length + 1)}`);
      }
    }
  }
  assert.deepEqual(offences, []);
});
