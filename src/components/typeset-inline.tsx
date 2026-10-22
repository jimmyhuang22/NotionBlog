"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { TextRun } from "../../contracts/content.ts";
import { renderSnippets } from "../lib/render/actions.ts";
import { withinLimits, type Snippet } from "../lib/render/snippets.ts";
import { InlineEquationText, type InlineEquation } from "./rich-text";

// Typeset markup by expression. Formulas repeat across entries, so one answer serves them all.
const markup = new Map<string, string>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function request(expressions: string[]) {
  const wanted = [...new Set(expressions)].filter(expression => !asked.has(expression));
  if (!wanted.length) return;
  const snippets = withinLimits(wanted.map((expression, index): Snippet => ({ id: `inline:${index}`, kind: "inline-equation", expression })));
  for (const snippet of snippets) if (snippet.kind === "inline-equation") asked.add(snippet.expression);
  // Formula styles arrive with the markup, so a formula never shows half-styled.
  Promise.all([renderSnippets(snippets), import("./katex-styles")]).then(([html]) => {
    for (const snippet of snippets) {
      const rendered = html[snippet.id];
      if (rendered && snippet.kind === "inline-equation") markup.set(snippet.expression, rendered);
    }
    for (const listener of listeners) listener();
  }, () => {
    // Left as source text; a later entry with the same formula may ask again.
    for (const snippet of snippets) if (snippet.kind === "inline-equation") asked.delete(snippet.expression);
  });
}

function TypesetInline({ expression }: { expression: string }) {
  const html = useSyncExternalStore(subscribe, () => markup.get(expression) ?? null, () => null);
  return <InlineEquationText expression={expression} html={html} />;
}

/**
 * A typesetter for the inline formulas in a line of text the browser renders itself (the text of a
 * list entry). The expression shows as source text first; the server returns the typeset markup, the
 * same way an expanded body gets its formulas, and the typesetter itself is never shipped to the
 * browser. Text without a formula asks for nothing.
 */
export function useTypesetInline(runs: TextRun[]): InlineEquation | undefined {
  const expressions = runs.filter(run => run.equation).map(run => run.text);
  const key = expressions.join("\u0000");
  useEffect(() => { if (key) request(key.split("\u0000")); }, [key]);
  return expressions.length ? TypesetInline : undefined;
}
