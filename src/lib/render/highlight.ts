import type { HighlighterCore, LanguageInput } from "shiki/core";

type Loader = () => Promise<{ default: LanguageInput }>;

/** A fixed set keeps the server bundle small; anything else is shown as plain text. */
const loaders: Record<string, Loader> = {
  bash: () => import("shiki/langs/bash.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

/** Names as they arrive from the content source, mapped to a grammar above. */
const aliases: Record<string, string> = {
  "c++": "cpp", "c#": "csharp", cs: "csharp", docker: "dockerfile", golang: "go", js: "javascript", ts: "typescript",
  py: "python", sh: "bash", shell: "bash", zsh: "bash", yml: "yaml", md: "markdown", rb: "ruby", rs: "rust", kt: "kotlin",
};

export function normalizeLanguage(name: string): string | null {
  const key = name.trim().toLowerCase();
  const language = aliases[key] ?? key;
  return Object.hasOwn(loaders, language) ? language : null;
}

const LIGHT = "github-light";
const DARK = "github-dark-dimmed";
/**
 * Both themes are drawn for their own editor background; on this site's softer code block
 * background a few of their colours fall under 4.5:1. Each is nudged in lightness only (same hue)
 * to just clear that ratio: comments, keywords, tags and variables in light, comments in dark.
 */
export const colorReplacements: Record<string, Record<string, string>> = {
  [LIGHT]: { "#6a737d": "#646d76", "#d73a49": "#cc2939", "#22863a": "#1f7c36", "#e36209": "#b24d07" },
  [DARK]: { "#768390": "#88949f" },
};
const MAX_LENGTH = 40_000;

let highlighter: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import("shiki/core"), import("shiki/engine/javascript"),
      import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark-dimmed.mjs"),
    ]);
    // The JavaScript regex engine avoids shipping a WebAssembly binary to the server runtime.
    return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return highlighter;
}

/**
 * Token spans for the inside of a <pre><code>, coloured through --shiki-light / --shiki-dark.
 * Returns null when the language is unknown, the block is very large, or highlighting fails,
 * so the caller falls back to plain text. The library escapes the code; nothing in it becomes markup.
 */
export async function highlightCode(code: string, languageName: string): Promise<string | null> {
  const language = normalizeLanguage(languageName);
  if (!language || code.length > MAX_LENGTH) return null;
  try {
    const instance = await getHighlighter();
    if (!instance.getLoadedLanguages().includes(language)) await instance.loadLanguage((await loaders[language]!()).default);
    return instance.codeToHtml(code, { lang: language, themes: { light: LIGHT, dark: DARK }, colorReplacements, defaultColor: false, structure: "inline" });
  } catch {
    return null;
  }
}
