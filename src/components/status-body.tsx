"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentDocument, StatusEntry } from "../../contracts/content.ts";
import { BrowserDocumentBody } from "./browser-document";
import { ContentImage } from "./content-image";
import { LightboxProvider } from "./lightbox";
import { readingLength, trimRuns } from "../lib/text-runs.ts";
import { RichText } from "./rich-text";
import { useTypesetInline } from "./typeset-inline";

type Problem = "busy" | "failed" | null;

/**
 * The list carries the extracted text and up to nine body images, and for a longer or structured entry
 * the opening of its body as blocks. Collapsed, that opening is shown typeset (quotes, rules, emphasis)
 * and cut to about nine lines, fading out; without it the plain text is shown as before. The whole
 * body is read from the detail endpoint only when the reader asks.
 */
export function StatusBody({ entry, titleLevel = 4 }: {
  entry: StatusEntry;
  /** Heading level of the entry's title: one below the month heading it sits under. */
  titleLevel?: 3 | 4;
}) {
  const Title = `h${titleLevel}` as const;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [loaded, setLoaded] = useState<{ document: ContentDocument | null } | null>(null);
  // Without the line breaks the source leaves at the end, which would show as an empty line in the card.
  const text = trimRuns(entry.text);
  const hasBody = text.length > 0;
  // A formula in the list text is typeset as it is in the full body, not left as its source.
  const Equation = useTypesetInline(text);
  const images = entry.images ?? [];
  // Only an explicit false means text and images already are the whole body; an adapter that
  // does not report the field keeps the expand control.
  // The opening of the body, typeset. Kept as one object so its formulas are typeset once.
  const preview = useMemo<ContentDocument | null>(() => entry.previewBody?.length ? { blocks: entry.previewBody, toc: [], completeness: "complete" } : null, [entry.previewBody]);
  const clip = useRef<HTMLDivElement>(null);
  // Closing a long body (M-02, 2026-10-20): it rolls up first, then the reader is brought back to where the entry begins.
  const card = useRef<HTMLDivElement>(null);
  const [folding, setFolding] = useState(false);
  const returning = useRef(false);
  function close() { setFolding(false); returning.current = true; setOpen(false); }
  useEffect(() => {
    if (!folding) return;
    const timer = window.setTimeout(close, 450);
    return () => window.clearTimeout(timer);
  }, [folding]);
  useEffect(() => {
    if (open || !returning.current) return;
    returning.current = false;
    const entry = card.current?.closest(".entry") ?? card.current;
    if (!entry) return;
    const header = document.querySelector(".site-header");
    const covered = header && getComputedStyle(header).position === "sticky" ? header.getBoundingClientRect().bottom : 0;
    const top = entry.getBoundingClientRect().top;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (top < covered + 8) window.scrollBy({ top: top - covered - 16, behavior: still ? "instant" : "smooth" });
  }, [open]);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const box = clip.current;
    if (!box) return;
    // The fade is drawn only when the opening is taller than the nine lines it is given.
    const measure = () => setClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
    // Measured again whenever the opening is drawn anew, as it is after the full body is closed.
  }, [preview, open, loaded]);
  const canExpand = entry.hasMoreBody !== false || (preview !== null && (entry.previewBodyTruncated === true || clipped));

  async function toggle() {
    if (open) {
      if (folding) return;
      if (full && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) setFolding(true); else close();
      return;
    }
    if (loaded) { setOpen(true); return; }
    if (pending) return;
    setPending(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/content/status/${encodeURIComponent(entry.slug)}`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.data) {
        setLoaded({ document: body.data.document ?? null });
        setOpen(true);
      } else {
        setProblem(body?.error?.code === "RATE_LIMITED" ? "busy" : "failed");
      }
    } catch {
      setProblem("failed");
    } finally {
      setPending(false);
    }
  }

  // An empty or unavailable body adds nothing: keep the list text and say so.
  const full = open && loaded?.document && (loaded.document.blocks.length > 0 || loaded.document.completeness === "partial") ? loaded.document : null;
  // The control sits on the card's last line, under the pictures, both folded and unfolded (F36).
  const more = canExpand ? (
    <button type="button" className="entry__more" onClick={toggle} disabled={pending} aria-expanded={open}>
      {pending ? "正在加载…" : open ? (full ? "收起" : "没有更多内容") : problem === "busy" ? "暂时加载不出来，稍后再试" : problem === "failed" ? "没有加载成功，重试" : preview && text.length ? `展开全文 · 约 ${readingLength(text)} 字` : "展开完整内容"}
    </button>
  ) : null;
  if (full) {
    return (
      <div ref={card} className={folding ? "card entry__card entry__card--full is-folding" : "card entry__card entry__card--full"}
        onAnimationEnd={event => { if (folding && event.target === event.currentTarget) close(); }}>
        <Title className="entry__card-title">{entry.title}</Title>
        <BrowserDocumentBody document={full} topHeading={titleLevel + 1} imagePreviewWidth={800} />
        {more}
      </div>
    );
  }
  // One picture is shown up to 420 wide, so it takes the 800 preview; a grid's tiles are small enough for 400.
  const single = images.length === 1 ? images[0]! : null;
  // A tall single picture is held to 420 high from its declared size, so nothing moves when it arrives.
  const tall = single?.width && single.height ? single.height / single.width > 1.6 : false;
  return (
    // Every entry is a card as wide as what it says, its pictures inside under the words; one without a body is just its title, as wide as its picture.
    <div ref={card} className={preview ? "card entry__card entry__card--full" : hasBody ? "card entry__card" : "card entry__card entry__card--brief"}>
      <Title className="entry__card-title">{entry.title}</Title>
      {preview ? (
        <div ref={clip} className="entry__preview" data-clipped={clipped ? "" : undefined}>
          <BrowserDocumentBody document={preview} topHeading={titleLevel + 1} />
        </div>
      ) : hasBody ? <p><RichText runs={text} Equation={Equation} /></p> : null}
      {images.length ? (
        <LightboxProvider className={`entry__photos entry__photos--${Math.min(images.length, 3)}${tall ? " entry__photos--tall" : ""}`}>
          {images.map((image, index) => <ContentImage key={`${image.id}:${index}`} image={image} previewWidth={single ? 800 : 400} />)}
          {tall ? <span className="entry__long" aria-hidden="true">长图</span> : null}
        </LightboxProvider>
      ) : null}
      {more}
    </div>
  );
}
