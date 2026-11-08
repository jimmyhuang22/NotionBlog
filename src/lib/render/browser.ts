import { createSnippetBatcher } from "./batch.ts";
import type { Snippet } from "./snippets.ts";

async function sendSnippets(snippets: Snippet[]): Promise<Record<string, string>> {
  const response = await fetch("/api/render/snippets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snippets),
    mode: "same-origin",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Snippet rendering failed.");
  const html: unknown = await response.json();
  if (!html || typeof html !== "object" || Array.isArray(html) ||
      Object.values(html).some(value => typeof value !== "string")) throw new Error("Invalid rendering response.");
  return html as Record<string, string>;
}

/**
 * The one way the browser asks for highlighted code and typeset formulas: every expanded body and
 * every list entry with a formula shares the same queue, so a page of entries is a few requests.
 */
export const renderInBrowser = createSnippetBatcher(sendSnippets);
