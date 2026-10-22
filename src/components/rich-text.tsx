import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import type { TextRun } from "../../contracts/content.ts";
import { hiddenPageLabel } from "../lib/placeholder-labels.ts";

/** Optional typesetter for inline formulas; without one the expression shows as text. */
export type InlineEquation = ComponentType<{ expression: string }>;

/** `html` is typesetter output with link and resource commands disabled; without it the source expression shows as text, never as markup. */
export function InlineEquationText({ expression, html = null }: { expression: string; html?: string | null }) {
  return html
    ? <span className="rt-equation" dangerouslySetInnerHTML={{ __html: html }} />
    : <code className="rt-code" role="math" aria-label={expression}>{expression}</code>;
}

function decorate(run: TextRun, Equation?: InlineEquation): ReactNode {
  let node: ReactNode = run.equation ? (Equation ? <Equation expression={run.text} /> : <InlineEquationText expression={run.text} />) : run.text;
  if (run.code) node = <code className="rt-code">{node}</code>;
  if (run.bold) node = <strong>{node}</strong>;
  if (run.italic) node = <em>{node}</em>;
  if (run.underline) node = <u>{node}</u>;
  if (run.strike) node = <s>{node}</s>;
  if (run.color && run.color !== "default") node = <span className={`rt-${run.color}`}>{node}</span>;
  const link = run.link;
  if (!link) return node;
  if (link.kind === "external") return <a className="rt-link" href={link.url} target="_blank" rel="noopener noreferrer">{node}</a>;
  if (link.kind === "internal") return <Link className="rt-link" prefetch={false} href={link.href}>{node}</Link>;
  // The target exists upstream but is not public: keep the words, offer no destination.
  // The service replaces a hidden page's name with a fixed placeholder; a plain one is said in the page's own language.
  return <span className="rt-unavailable" title="这个页面暂未开放">{run.text === hiddenPageLabel(run.text) ? node : hiddenPageLabel(run.text)}</span>;
}

/** Text is always rendered through React escaping; runs never become raw HTML. */
export function RichText({ runs, Equation }: { runs: TextRun[]; Equation?: InlineEquation }) {
  return <>{runs.map((run, index) => <span key={index}>{decorate(run, Equation)}</span>)}</>;
}

export function plainText(runs: TextRun[]): string {
  return runs.map(run => run.text).join("");
}
