import "server-only";
import "katex/dist/katex.min.css";
import type { ContentBlock, ContentDocument } from "../../contracts/content.ts";
import { highlightCode } from "@/lib/render/highlight";
import { renderEquation } from "@/lib/render/equation";
import { CodeFigure, DocumentBody, EquationFigure, type BlockExtensions } from "./blocks";
import { InlineEquationText } from "./rich-text";

type CodeBlock = Extract<ContentBlock, { type: "code" }>;
type EquationBlock = Extract<ContentBlock, { type: "equation" }>;

async function HighlightedCode({ block }: { block: CodeBlock }) {
  return <CodeFigure block={block} html={await highlightCode(block.code, block.language)} />;
}

function TypesetEquation({ block }: { block: EquationBlock }) {
  return <EquationFigure block={block} html={renderEquation(block.expression)} />;
}

function TypesetInlineEquation({ expression }: { expression: string }) {
  return <InlineEquationText expression={expression} html={renderEquation(expression, false)} />;
}

const extensions: BlockExtensions = { Code: HighlightedCode, Equation: TypesetEquation, InlineEquation: TypesetInlineEquation };

/**
 * Server-rendered documents get syntax highlighting and typeset formulas. Bodies rendered in the
 * browser (an expanded status) use BrowserDocumentBody, which asks the server for the same markup.
 */
export function RichDocumentBody(props: { document: ContentDocument | null; emptyText?: string; imagePreviewWidth?: 400 | 800 }) {
  return <DocumentBody {...props} extensions={extensions} />;
}
