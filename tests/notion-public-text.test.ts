import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePublicText } from "../src/server/notion/public-text.ts";
import { resolveNotionTextLink } from "../src/server/notion/blocks.ts";

test("temporary media locations in ordinary body text or hyperlinks never enter public DTOs", async () => {
  const location = new URL("https://assets.example.test/image.png");
  location.searchParams.set("X-Amz-Signature", "fictional-signature");
  assert.equal(sanitizePublicText(`See ${location.href}`), "See Media");
  const context = { resolvePageLink: async () => null, registerImage: async () => null };
  assert.deepEqual(await resolveNotionTextLink(location.href, context), { kind: "unavailable" });
  const ordinary = "https://example.test/docs?q=one";
  assert.equal(sanitizePublicText(ordinary), ordinary);
  assert.deepEqual(await resolveNotionTextLink(ordinary, context), { kind: "external", url: ordinary });
});
