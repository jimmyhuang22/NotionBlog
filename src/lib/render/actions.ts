"use server";

import { renderEquation } from "./equation.ts";
import { highlightCode } from "./highlight.ts";
import { MAX_SNIPPETS, MAX_SNIPPET_CHARS, type Snippet } from "./snippets.ts";

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

/** Anyone can post to a server function, so the shape and size are checked before any work is done. */
function parseSnippets(input: unknown): Snippet[] | null {
  if (!Array.isArray(input) || input.length > MAX_SNIPPETS) return null;
  const snippets: Snippet[] = [];
  let chars = 0;
  for (const value of input as unknown[]) {
    if (typeof value !== "object" || value === null) return null;
    const { id, kind, code, language, expression } = value as Record<string, unknown>;
    if (!isText(id, 128) || !id) return null;
    if (kind === "code" && isText(code, MAX_SNIPPET_CHARS) && isText(language, 64)) snippets.push({ id, kind, code, language });
    else if ((kind === "equation" || kind === "inline-equation") && isText(expression, MAX_SNIPPET_CHARS)) snippets.push({ id, kind, expression });
    else return null;
    chars += kind === "code" ? (code as string).length : (expression as string).length;
    if (chars > MAX_SNIPPET_CHARS) return null;
  }
  return snippets;
}

/**
 * Highlighted code and typeset formulas for a body the browser renders itself (an expanded status),
 * keyed by block id. It only transforms what it is given and reads no content. A snippet that cannot
 * be rendered is left out and stays plain text; invalid input yields nothing.
 */
export async function renderSnippets(input: unknown): Promise<Record<string, string>> {
  const snippets = parseSnippets(input);
  if (!snippets) return {};
  const rendered = await Promise.all(snippets.map(async snippet =>
    [snippet.id, snippet.kind === "code" ? await highlightCode(snippet.code, snippet.language) : renderEquation(snippet.expression, snippet.kind === "equation")] as const));
  return Object.fromEntries(rendered.filter((entry): entry is readonly [string, string] => entry[1] !== null));
}
