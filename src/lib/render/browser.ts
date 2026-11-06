import { renderSnippets } from "./actions.ts";
import { createSnippetBatcher } from "./batch.ts";

/**
 * The one way the browser asks for highlighted code and typeset formulas: every expanded body and
 * every list entry with a formula shares the same queue, so a page of entries is a few requests.
 */
export const renderInBrowser = createSnippetBatcher(renderSnippets);
