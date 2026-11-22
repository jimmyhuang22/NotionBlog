import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "next/dist/build/swc/index.js";
import { contactCode } from "../src/lib/contact.ts";

// Render the actual TSX views with their unrelated boundaries replaced by explicit local ports.
function view(path: string, ports: Record<string, unknown> = {}): Record<string, any> {
  const output = transformSync(readFileSync(new URL("../" + path, import.meta.url), "utf8"), {
    filename: path, swcrc: false, configFile: false, module: { type: "commonjs" },
    jsc: { parser: { syntax: "typescript", tsx: true }, target: "es2022", transform: { react: { runtime: "automatic" } } },
  });
  const module = { exports: {} };
  const imports: Record<string, unknown> = { "react/jsx-runtime": jsx, react: React, ...ports };
  runInNewContext(output.code, { module, exports: module.exports, require: (name: string) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected view dependency: ${name}`); return imports[name];
  } }, { timeout: 1000 });
  return module.exports;
}

const ADDRESS = "someone@example.test";
const socials = [
  { platform: "bilibili" as const, url: "https://space.bilibili.com/1", label: "哔哩哔哩" },
  { platform: "email" as const, url: `mailto:${ADDRESS}`, label: "邮箱" },
];

test("the contact code carries the configured address, and nothing when no email is configured", () => {
  const code = contactCode(socials);
  assert.ok(code);
  assert.ok(!code.includes("@"));
  assert.equal(Buffer.from(code, "base64").toString("utf8"), ADDRESS);
  assert.equal(contactCode(socials.slice(0, 1)), null);
});

test("the profile icons and the closed card carry no plain address or mailto link", () => {
  // Dismissal only listens once the card is open; the closed card rendered here never reaches it.
  const { ContactCard } = view("src/components/contact-card.tsx", { "./use-dismiss": { useMenuDismiss: () => {} } });
  const SocialLinks = view("src/components/social-links.tsx", {
    "@/lib/contact": { contactCode },
    "./contact-card": { ContactCard },
    "./social-icon-paths": { socialIconPaths: { bilibili: "M0 0" } },
  }).SocialLinks;
  const element = SocialLinks({ links: socials });
  // The list's keys travel with the page data, so none may carry the address.
  assert.ok(!JSON.stringify(React.Children.map(element.props.children, (child: React.ReactElement) => child.key)).includes(ADDRESS));
  const html = renderToStaticMarkup(element);
  assert.ok(!html.includes(ADDRESS) && !html.includes("mailto:"));
  // The envelope is a button that opens the card, labelled as configured; the other icons stay links.
  assert.match(html, /<button type="button" aria-label="邮箱" title="邮箱" aria-expanded="false" data-platform="email">/);
  assert.match(html, /<a href="https:\/\/space\.bilibili\.com\/1"/);
  assert.equal(contactCode([]), null);
});
