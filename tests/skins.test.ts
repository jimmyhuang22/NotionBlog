import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DEFAULT_SKIN, isSkin, rootAttributes, schemeFor, skins, themeScript } from "../src/lib/skins.ts";

test("a skin with one scheme always shows it; the others follow the stored choice or the system", () => {
  assert.equal(schemeFor("island", "light", "dark"), "light");
  assert.equal(schemeFor("island", null, "dark"), "dark");
  assert.equal(schemeFor("y2k", "dark", "dark"), "light");
  assert.equal(schemeFor("ink", "dark", "light"), "dark");
  assert.equal(schemeFor("apple", null, "dark"), "dark");
  assert.equal(schemeFor("ink", null, "light"), "light");
});

test("root attributes leave the default skin unmarked and pin the fixed schemes", () => {
  assert.deepEqual(rootAttributes("ink", null), { skin: null, theme: null });
  assert.deepEqual(rootAttributes("ink", "dark"), { skin: null, theme: "dark" });
  assert.deepEqual(rootAttributes("apple", "light"), { skin: "apple", theme: "light" });
  assert.deepEqual(rootAttributes("island", "light"), { skin: "island", theme: "light" });
  assert.deepEqual(rootAttributes("island", null), { skin: "island", theme: null });
  assert.deepEqual(rootAttributes("y2k", null), { skin: "y2k", theme: "light" });
});

test("only listed skins are accepted and the pre-paint script knows every one", () => {
  assert.equal(isSkin("apple"), true);
  assert.equal(isSkin("neon"), false);
  assert.equal(isSkin(undefined), false);
  assert.equal(DEFAULT_SKIN, "ink");
  for (const skin of skins) {
    if (skin.id === DEFAULT_SKIN) continue;
    assert.ok(themeScript.includes(`"${skin.id}"`), `${skin.id} is missing from the pre-paint script`);
  }
  assert.ok(themeScript.includes('"y2k":"light"') && !themeScript.includes('"island":'));
});

test("the pre-paint script applies a stored skin and its fixed scheme without touching anything else", () => {
  const run = (stored: Record<string, string>) => {
    const dataset: Record<string, string> = {};
    const fn = new Function("document", "localStorage", themeScript);
    fn({ documentElement: { dataset } }, { getItem: (key: string) => stored[key] ?? null });
    return dataset;
  };
  assert.deepEqual(run({}), {});
  assert.deepEqual(run({ theme: "dark" }), { theme: "dark" });
  assert.deepEqual(run({ skin: "island", theme: "light" }), { skin: "island", theme: "light" });
  assert.deepEqual(run({ skin: "island" }), { skin: "island" });
  assert.deepEqual(run({ skin: "y2k" }), { skin: "y2k", theme: "light" });
  assert.deepEqual(run({ skin: "apple", theme: "light" }), { skin: "apple", theme: "light" });
  assert.deepEqual(run({ skin: "neon", theme: "odd" }), {});
  // The pixel skin was removed on 2026-10-19; a visitor who had chosen it gets ink, with their stored scheme.
  assert.deepEqual(run({ skin: "pixel", theme: "dark" }), { theme: "dark" });
  // The notebook was replaced by the island on 2026-10-21; a visitor who had chosen it arrives at the island with their scheme.
  assert.deepEqual(run({ skin: "note", theme: "dark" }), { skin: "island", theme: "dark" });
  assert.deepEqual(run({ skin: "note" }), { skin: "island" });
});

test("a backdrop blur is written prefix first, or the build drops the standard declaration", () => {
  const directory = new URL("../src/app/", import.meta.url);
  let found = 0;
  for (const name of readdirSync(directory).filter(file => file.endsWith(".css"))) {
    const css = readFileSync(new URL(name, directory), "utf8");
    for (const match of css.matchAll(/(?<!-webkit-)backdrop-filter:\s*([^;}]+);/gu)) {
      found += 1;
      assert.ok(css.slice(0, match.index).endsWith(`-webkit-backdrop-filter: ${match[1]}; `), `${name}: ${match[0]}`);
    }
    assert.equal([...css.matchAll(/-webkit-backdrop-filter:/gu)].length, [...css.matchAll(/(?<!-webkit-)backdrop-filter:/gu)].length, name);
  }
  // The apple header is the one blur left (y2k cards are solid white now); the count only proves the pattern still matches something.
  assert.ok(found >= 1);
});
