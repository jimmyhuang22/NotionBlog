"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ContentBlock, ContentDocument } from "../../contracts/content.ts";
import { renderSnippets } from "../lib/render/actions.ts";
import { collectSnippets, withinLimits } from "../lib/render/snippets.ts";
import { CodeFigure, DocumentBody, EquationFigure, type BlockExtensions } from "./blocks";
import { InlineEquationText } from "./rich-text";

/** Markup for code and formula blocks by block id, and for inline formulas by expression. */
interface Rendered { blocks: ReadonlyMap<string, string>; inline: ReadonlyMap<string, string> }
const none: Rendered = { blocks: new Map(), inline: new Map() };
const RenderedContext = createContext<Rendered>(none);

// One request per loaded body; collapsing and expanding again reuses the result.
const pending = new WeakMap<ContentDocument, Promise<Rendered>>();
const settled = new WeakMap<ContentDocument, Rendered>();

function load(document: ContentDocument): Promise<Rendered> {
  let request = pending.get(document);
  if (!request) {
    const snippets = withinLimits(collectSnippets(document.blocks));
    request = snippets.length
      // Formula styles arrive with the markup, so a formula never shows half-styled.
      ? Promise.all([renderSnippets(snippets), snippets.some(snippet => snippet.kind !== "code") ? import("./katex-styles") : null])
        .then(([html]): Rendered => {
          const markup = new Map(Object.entries(html));
          const inline = new Map<string, string>();
          for (const snippet of snippets) {
            if (snippet.kind !== "inline-equation") continue;
            const rendered = markup.get(snippet.id);
            if (rendered) inline.set(snippet.expression, rendered);
          }
          return { blocks: markup, inline };
        })
      : Promise.resolve(none);
    pending.set(document, request);
    request.then(rendered => settled.set(document, rendered), () => pending.delete(document));
  }
  return request;
}

function Code({ block }: { block: Extract<ContentBlock, { type: "code" }> }) {
  return <CodeFigure block={block} html={useContext(RenderedContext).blocks.get(block.id)} />;
}

function Equation({ block }: { block: Extract<ContentBlock, { type: "equation" }> }) {
  return <EquationFigure block={block} html={useContext(RenderedContext).blocks.get(block.id)} />;
}

function InlineEquation({ expression }: { expression: string }) {
  return <InlineEquationText expression={expression} html={useContext(RenderedContext).inline.get(expression)} />;
}

const extensions: BlockExtensions = { Code, Equation, InlineEquation };

/**
 * A body rendered in the browser. Code and formulas appear as plain text first, then the server
 * returns their highlighted and typeset markup in one request; if that fails the plain text stays.
 * The highlighter and typesetter themselves are never shipped to the browser.
 */
export function BrowserDocumentBody({ document, topHeading, emptyText, imagePreviewWidth }: { document: ContentDocument; topHeading?: number; emptyText?: string; imagePreviewWidth?: 400 | 800 }) {
  const [rendered, setRendered] = useState<Rendered>(() => settled.get(document) ?? none);
  useEffect(() => {
    let current = true;
    load(document).then(result => { if (current) setRendered(result); }, () => {});
    return () => { current = false; };
  }, [document]);
  return <RenderedContext.Provider value={rendered}><DocumentBody document={document} emptyText={emptyText} extensions={extensions} topHeading={topHeading} imagePreviewWidth={imagePreviewWidth} /></RenderedContext.Provider>;
}
