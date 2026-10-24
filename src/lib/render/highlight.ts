import type { HighlighterCore, LanguageInput, ThemeRegistrationRaw } from "shiki/core";

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

/**
 * The site's own code colours (round four, C-06, in place of GitHub's): keywords and strings in the accent,
 * comments muted, everything else, numbers, operators and punctuation included, in ink. The theme names roles,
 * not colours: each span reads var(--code-ink), var(--code-key) or var(--code-note), which prose.css sets from the
 * skin's own tokens, so every skin and both schemes follow without a second theme.
 */
export const CODE_ROLES = ["--code-ink", "--code-key", "--code-note"] as const;
const role = (name: (typeof CODE_ROLES)[number]) => `var(${name})`;
const THEME: ThemeRegistrationRaw = {
  name: "site",
  type: "light",
  colors: { "editor.foreground": role("--code-ink"), "editor.background": "transparent" },
  settings: [
    { settings: { foreground: role("--code-ink") } },
    { scope: ["comment", "punctuation.definition.comment", "string.quoted.docstring.multi"], settings: { foreground: role("--code-note") } },
    { scope: ["keyword", "storage.type", "storage.modifier", "entity.name.tag", "support.type.property-name.json"], settings: { foreground: role("--code-key") } },
    { scope: ["string", "markup.inline.raw", "markup.fenced_code"], settings: { foreground: role("--code-key") } },
    // More specific than "keyword" and "string": the colons in a MAC address or the = in a formula stay ink.
    { scope: ["keyword.operator", "keyword.control.ternary", "punctuation", "punctuation.definition.string"], settings: { foreground: role("--code-ink") } },
  ],
};
const MAX_LENGTH = 40_000;
const MAX_LINE_LENGTH = 1_000;
const LINE_TIME_LIMIT_MS = 200;

let highlighter: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);
    // The JavaScript regex engine avoids shipping a WebAssembly binary to the server runtime.
    return createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return highlighter;
}

/**
 * Token spans for the inside of a <pre><code>, each coloured by one of CODE_ROLES.
 * Returns null when the language is unknown, the block is very large, or highlighting fails,
 * so the caller falls back to plain text. The library escapes the code; nothing in it becomes markup.
 */
export async function highlightCode(code: string, languageName: string): Promise<string | null> {
  const language = normalizeLanguage(languageName);
  if (!language || code.length > MAX_LENGTH) return null;
  try {
    const instance = await getHighlighter();
    if (!instance.getLoadedLanguages().includes(language)) await instance.loadLanguage((await loaders[language]!()).default);
    // One very long line can keep the regex engine busy for half a minute (a 40,000-character JavaScript line took
    // 32 s here); such a line stays plain, and no line may take longer than the time limit.
    return instance.codeToHtml(code, { lang: language, theme: "site", structure: "inline", tokenizeMaxLineLength: MAX_LINE_LENGTH, tokenizeTimeLimit: LINE_TIME_LIMIT_MS });
  } catch {
    return null;
  }
}
