"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Page } from "../../contracts/content.ts";
import type { SearchHit } from "../../contracts/website.ts";
import { MAX_QUERY, isSearchShortcut, kindLabels, readQuery, readableExcerpt, searchHref, searchResultHref, searchResultLabel, stepOption } from "../lib/search.ts";
import { Marked } from "./search-results";
import { SearchContextLine } from "./search-context-line";

const LIMIT = 6;
const DELAY = 280;

interface Results { status: "idle" | "loading" | "done" | "busy" | "failed"; query: string | null; hits: SearchHit[]; total: number | null }
const idle: Results = { status: "idle", query: null, hits: [], total: null };

const Magnifier = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="5" /><path d="m12 12 3.5 3.5" /></svg>
);

/**
 * The header's search entry. A plain click, "/" or Ctrl/⌘ + K opens quick search over the current
 * page: results appear while typing, arrow keys choose, Enter opens. The entry is still a link to
 * the search page, so it works without scripts, in a new tab, and for the full result list.
 */
export function SearchPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [results, setResults] = useState<Results>(idle);
  const [active, setActive] = useState(-1);
  // Text being composed by an input method is not a query yet; the search waits until it is committed.
  const [composing, setComposing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const listId = useId();
  const query = readQuery(text);
  // Input changes render before the debounce runs; only the current query can offer options.
  const showingResults = !composing && !!query && results.query === query && results.status === "done";
  // The last option leads to the search page with everything that matched.
  const count = showingResults ? results.hits.length + 1 : 0;
  const selected = active >= 0 && active < count ? active : -1;

  useEffect(() => {
    if (open && selected >= 0) document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [open, selected, listId]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (!isSearchShortcut(event, typing)) return;
      event.preventDefault();
      // On the search page its own field is the search; there is nothing to lay over it.
      const pageField = document.querySelector<HTMLInputElement>(".search__input");
      if (pageField) pageField.focus(); else setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);

  // Following a result, or any other navigation, puts the palette away.
  useEffect(() => { dialog.current?.close(); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    if (!query) { setResults(idle); setActive(-1); return; }
    if (composing) return;
    const control = new AbortController();
    const timer = setTimeout(async () => {
      setResults({ status: "loading", query, hits: [], total: null });
      try {
        const response = await fetch(`/api/search?${new URLSearchParams({ q: query, limit: String(LIMIT) })}`, { cache: "no-store", signal: control.signal });
        const body = await response.json().catch(() => null);
        if (control.signal.aborted) return;
        if (response.ok && body?.data) {
          const page = body.data as Page<SearchHit>;
          setResults({ status: "done", query, hits: page.items, total: page.total ?? null });
          setActive(page.items.length ? 0 : -1);
        } else {
          setResults({ status: body?.error?.code === "RATE_LIMITED" ? "busy" : "failed", query, hits: [], total: null });
          setActive(-1);
        }
      } catch {
        if (!control.signal.aborted) { setResults({ status: "failed", query, hits: [], total: null }); setActive(-1); }
      }
    }, DELAY);
    return () => { clearTimeout(timer); control.abort(); };
  }, [open, query, composing, attempt]);

  function close() { dialog.current?.close(); }
  function go(href: string) { close(); router.push(href); }
  function hrefOf(index: number): string | null {
    if (!showingResults || !results.query || index < 0 || index >= count) return null;
    return index < results.hits.length ? searchResultHref(results.hits[index]!) : searchHref(results.query, null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // While an input method is composing, Enter, Escape and the arrows belong to it.
    if (event.nativeEvent.isComposing || composing) return;
    if (event.key === "Escape") {
      // A search field would otherwise spend the first Escape on clearing its text.
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(current => stepOption(current, count, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Nothing chosen yet (still loading, or no match): go to the search page with what was typed.
      const href = hrefOf(selected) ?? (query ? searchHref(query, null) : null);
      if (href) go(href);
    }
  }

  const waiting = !!query && !composing && (results.query !== query || results.status === "idle" || results.status === "loading");
  const retryable = !!query && !composing && results.query === query && (results.status === "busy" || results.status === "failed");
  const message = !query ? (text.trim() ? "这个关键词太长，或者包含无法搜索的字符。" : "输入关键词，搜标题和正文。")
    : composing ? null
    : waiting ? "正在搜索…"
    : results.status === "busy" ? "暂时搜不了，请稍后再试。"
    : results.status === "failed" ? "这次搜索没有成功，请稍后再试。"
    : results.status === "done" && !results.hits.length ? `没有找到包含“${results.query}”的内容。`
    : null;

  return (
    <>
      <Link
        className="icon-button" href="/search" aria-label="搜索" aria-haspopup="dialog" aria-keyshortcuts="/ Control+K Meta+K" prefetch={false}
        onClick={event => {
          // Modified clicks keep their meaning (new tab), and on the search page the link is already there.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0 || pathname === "/search") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <Magnifier />
      </Link>
      <dialog
        ref={dialog} className="palette" aria-label="搜索"
        onClose={() => { setOpen(false); setText(""); setResults(idle); setActive(-1); setComposing(false); }}
        onClick={event => { if (event.target === dialog.current) close(); }}
      >
        {open ? (
          <div className="palette__panel">
            <div className="palette__field">
              <Magnifier />
              <input
                ref={input} className="palette__input" type="search" role="combobox" aria-label="搜索内容" aria-autocomplete="list"
                aria-expanded={count > 0} aria-controls={listId} aria-activedescendant={selected >= 0 ? `${listId}-${selected}` : undefined}
                placeholder="搜标题和正文" maxLength={MAX_QUERY} autoComplete="off" enterKeyHint="search" autoFocus
                value={text} onChange={event => setText(event.target.value)} onKeyDown={onKeyDown}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={event => { setComposing(false); setText((event.target as HTMLInputElement).value); }}
              />
              <button type="button" className="palette__close" onClick={close} aria-label="关闭搜索"><kbd aria-hidden="true">Esc</kbd><span aria-hidden="true">关闭</span></button>
            </div>
            <ul id={listId} className="palette__list" role="listbox" aria-label="搜索结果" aria-busy={waiting}>
              {showingResults ? results.hits.map((hit, index) => (
                <li key={`${hit.kind}:${hit.id}`} id={`${listId}-${index}`} className="palette__option" role="option" aria-selected={index === selected} onPointerMove={() => setActive(index)}>
                  <Link href={searchResultHref(hit)} aria-label={searchResultLabel(hit)} prefetch={false} tabIndex={-1} onClick={close}>
                    <span className="tag">{kindLabels[hit.kind] ?? "内容"}</span>
                    <span className="palette__content">
                      <span className="palette__title"><Marked text={hit.title} query={results.query!} /></span>
                      <SearchContextLine context={hit.context} />
                      {hit.excerpt ? <span className="palette__excerpt"><Marked text={readableExcerpt(hit.excerpt)} query={results.query!} /></span> : null}
                    </span>
                  </Link>
                </li>
              )) : null}
              {count > 0 ? (
                <li id={`${listId}-${count - 1}`} className="palette__option palette__option--all" role="option" aria-selected={selected === count - 1} onPointerMove={() => setActive(count - 1)}>
                  <Link href={searchHref(results.query!, null)} prefetch={false} tabIndex={-1} onClick={close}>
                    {typeof results.total === "number" && results.total > results.hits.length ? `查看全部 ${results.total} 条结果` : "在搜索页里查看"}
                  </Link>
                </li>
              ) : null}
            </ul>
            {/* Before any typing the hint would only repeat the placeholder on screen; it is still read out (X-03). */}
            <div className={!query && !text.trim() ? "palette__status visually-hidden" : "palette__status"}>
              <p role="status">{message}</p>
              {retryable ? (
                <button type="button" className="search-recovery__action" onClick={() => {
                  if (!retryable) return;
                  setResults({ status: "loading", query, hits: [], total: null });
                  setActive(-1);
                  setAttempt(current => current + 1);
                  input.current?.focus();
                }}>重新搜索</button>
              ) : showingResults && !results.hits.length ? (
                <button type="button" className="search-recovery__action" onClick={() => { input.current?.focus(); input.current?.select(); }}>修改关键词</button>
              ) : null}
            </div>
            <p className="palette__foot" aria-hidden="true"><span>↑↓ 选择</span><span>回车 打开</span><span>/ 或 ⌘K 随时搜索</span></p>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
