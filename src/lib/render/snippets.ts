import type { ContentBlock, TextRun } from "../../../contracts/content.ts";

/** The parts of a body that the server can render better than the browser: code and formulas. */
export type Snippet =
  | { id: string; kind: "code"; code: string; language: string }
  | { id: string; kind: "equation"; expression: string }
  /** A formula inside a line of text. Each distinct expression is sent once, under an id of its own. */
  | { id: string; kind: "inline-equation"; expression: string };

export const MAX_SNIPPETS = 24;
/** Combined source length accepted in one request; larger bodies keep their plain-text form. */
export const MAX_SNIPPET_CHARS = 60_000;

/** Text runs a block shows directly; nested blocks are visited separately. */
function runsOf(block: ContentBlock): TextRun[][] {
  switch (block.type) {
    case "paragraph": case "heading": case "quote": case "callout": return [block.text];
    case "toggle": return [block.title];
    case "list": return block.items.map(item => item.text);
    case "code": case "image": return [block.caption];
    case "table": return block.rows.flat();
    default: return [];
  }
}

/**
 * Code blocks, formula blocks and inline formulas in reading order, including those nested in
 * lists, callouts, toggles and columns.
 */
export function collectSnippets(blocks: ContentBlock[]): Snippet[] {
  const found: Snippet[] = [];
  const inline = new Set<string>();
  const visit = (items: ContentBlock[]) => {
    for (const block of items) {
      for (const runs of runsOf(block)) {
        for (const run of runs) {
          if (!run.equation || inline.has(run.text)) continue;
          inline.add(run.text);
          found.push({ id: `inline:${inline.size}`, kind: "inline-equation", expression: run.text });
        }
      }
      if (block.type === "code") found.push({ id: block.id, kind: "code", code: block.code, language: block.language });
      else if (block.type === "equation") found.push({ id: block.id, kind: "equation", expression: block.expression });
      else if (block.type === "list") for (const item of block.items) visit(item.children);
      else if (block.type === "callout" || block.type === "toggle") visit(block.children);
      else if (block.type === "columns") for (const column of block.columns) visit(column.blocks);
    }
  };
  visit(blocks);
  return found;
}

/** The leading snippets that fit one request; the rest stay as plain text. */
export function withinLimits(snippets: Snippet[]): Snippet[] {
  const accepted: Snippet[] = [];
  let chars = 0;
  for (const snippet of snippets) {
    chars += snippet.kind === "code" ? snippet.code.length : snippet.expression.length;
    if (accepted.length >= MAX_SNIPPETS || chars > MAX_SNIPPET_CHARS) break;
    accepted.push(snippet);
  }
  return accepted;
}
