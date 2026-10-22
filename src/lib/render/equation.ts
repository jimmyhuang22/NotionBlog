import katex from "katex";

const MAX_LENGTH = 4_000;

/**
 * Typeset markup for a TeX expression, or null when it cannot be rendered, so the caller shows
 * the source text instead. Commands that could emit links or load resources stay disabled.
 */
export function renderEquation(expression: string, displayMode = true): string | null {
  const source = expression.trim();
  if (!source || source.length > MAX_LENGTH) return null;
  try {
    const html = katex.renderToString(source, { displayMode, throwOnError: true, trust: false, strict: "ignore", maxExpand: 500, maxSize: 30 });
    // Defence in depth: typeset maths never needs links or external resources.
    return /<a[\s>]|\shref=|\ssrc=|<script|<iframe/iu.test(html) ? null : html;
  } catch {
    return null;
  }
}
