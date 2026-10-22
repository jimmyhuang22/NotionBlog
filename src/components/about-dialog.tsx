"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import type { SitePage } from "../../contracts/content.ts";
import { updatedLabel } from "../lib/format.ts";
import { BrowserDocumentBody } from "./browser-document";
import { Avatar } from "./avatar";

type About = { status: "idle" | "loading" | "busy" | "failed" | "gone" } | { status: "done"; page: SitePage };

const EMPTY = "这一页还没有内容。";

/**
 * The way from the home page's picture to the about page. It is a link to that page, so it works
 * without scripts and in a new tab; a plain click opens the page's content over the home page
 * instead. The content is read on the first opening only, never with the home page itself.
 */
export function AboutDialog({ timeZone, avatar = null, name = "" }: { timeZone: string; avatar?: string | null; name?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState<About>({ status: "idle" });
  const loading = useRef(false);
  const titleId = useId();

  async function load() {
    if (loading.current) return;
    loading.current = true;
    setAbout({ status: "loading" });
    try {
      const response = await fetch("/api/pages/about", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.data) setAbout({ status: "done", page: body.data as SitePage });
      // The page can be withdrawn between the home page being drawn and the picture being pressed.
      else setAbout({ status: response.status === 404 ? "gone" : body?.error?.code === "RATE_LIMITED" ? "busy" : "failed" });
    } catch {
      setAbout({ status: "failed" });
    } finally {
      loading.current = false;
    }
  }

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);

  function close() { dialog.current?.close(); }
  /** A link in the text leads away from the home page, so the dialog goes first; a link within the text does not. */
  function onPanelClick(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as Element).closest("a[href]");
    if (link && link.getAttribute("target") !== "_blank" && !link.getAttribute("href")!.startsWith("#")) close();
  }

  const updated = about.status === "done" ? updatedLabel(about.page.updatedAt, timeZone) : null;
  return (
    <>
      <Link
        className="hero__about" href="/about" aria-label="关于我" aria-haspopup="dialog" prefetch={false}
        onClick={event => {
          // Modified clicks keep their meaning (new tab).
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          setOpen(true);
          // What was read once is kept; an opening after a failure tries again.
          if (about.status !== "done") void load();
        }}
      >
        {/* Says "this opens" where nothing can hover: a small mark on the picture's lower right. */}
        <span className="hero__about-mark" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 2.5 9.5 7 5 11.5" /></svg></span>
      </Link>
      <dialog
        ref={dialog} className="about-dialog" aria-labelledby={titleId}
        // The image viewer inside the text is a dialog too, and React passes its close event up to this one.
        onClose={event => { if (event.target === event.currentTarget) setOpen(false); }}
        onClick={event => { if (event.target === dialog.current) close(); }}
      >
        {open ? (
          <div className="about-dialog__panel" onClick={onPanelClick}>
            {/* A calling card (2026-10-20): the picture, the title over a stroke of the pen, the words centred. */}
            <header className="about-dialog__head">
              <Avatar src={avatar} name={name} />
              <h2 id={titleId}>关于</h2>
              <button type="button" className="icon-button about-dialog__close" onClick={close} aria-label="关闭">
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l10 10M14 4 4 14" /></svg>
              </button>
            </header>
            <div className="about-dialog__body">
              {about.status === "done" ? (
                about.page.document
                  ? <BrowserDocumentBody document={about.page.document} emptyText={EMPTY} topHeading={3} imagePreviewWidth={800} />
                  : <div className="prose"><p className="prose__muted">{EMPTY}</p></div>
              ) : about.status === "busy" || about.status === "failed" ? (
                <div className="state" role="status">
                  <p>{about.status === "busy" ? "暂时加载不出来，请稍后重试。" : "没有加载成功，请重试。"}</p>
                  <button type="button" className="pill-button" onClick={load}>重试</button>
                </div>
              ) : about.status === "gone" ? (
                <div className="state" role="status"><p>这一页现在看不了。</p></div>
              ) : (
                <div className="about-dialog__loading" role="status" aria-label="正在加载">
                  {[92, 100, 64].map(width => <span key={width} className="skeleton" style={{ width: `${width}%` }} />)}
                </div>
              )}
              {updated ? <p className="about-dialog__updated">{updated}</p> : null}
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
