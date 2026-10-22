import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const directory = new URL("../src/app/", import.meta.url);
const sheets = readdirSync(directory).filter(name => name.endsWith(".css")).map(name => ({ name, css: readFileSync(new URL(name, directory), "utf8") }));

test("stylesheets take font sizes from the type scale", () => {
  assert.ok(sheets.length >= 5);
  for (const { name, css } of sheets) {
    // Sizes are a step of the scale, a clamp() between steps for headings that follow the window, or relative to their context.
    for (const [declaration, value] of css.matchAll(/font-size:\s*([^;}]+)/gu)) {
      assert.match(value!.trim(), /^(var\(--text-[a-z0-9]+\)|clamp\(.+\)|[\d.]+em|inherit)( !important)?$/u, `${name}: ${declaration}`);
    }
  }
});

test("stylesheets take corner radii from the radius scale", () => {
  for (const { name, css } of sheets) {
    for (const [declaration, value] of css.matchAll(/border-radius:\s*([^;}]+)/gu)) {
      // One of the four steps, a pill, a circle, the parent's radius, or a shape built from several values.
      const single = /^(var\(--radius-(xs|sm|md|lg)\)|999px|50%|22%|30%|inherit|0)$/u.test(value!.trim());
      assert.ok(single || value!.trim().includes(" "), `${name}: ${declaration}`);
    }
  }
});

test("the scale itself stays small", () => {
  const tokens = sheets.find(sheet => sheet.name === "globals.css")!.css;
  assert.equal(new Set([...tokens.matchAll(/--text-[a-z0-9]+(?=:)/gu)].map(match => match[0])).size, 9);
  assert.equal(new Set([...tokens.matchAll(/--radius-[a-z]+(?=:)/gu)].map(match => match[0])).size, 4);
  const skins = sheets.find(sheet => sheet.name === "skins.css")!.css;
  assert.deepEqual([...skins.matchAll(/--text-[a-z0-9]+(?=:)/gu)], []);
});
