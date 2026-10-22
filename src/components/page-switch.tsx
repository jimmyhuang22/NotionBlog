"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Moving between pages inside the site: only one page is ever on screen (F45, the owner's choice of
 * 2026-10-21, revising F43's cross-fade, which showed two notes' text at once for a moment).
 *
 * Next swaps the old page for the new route's loading state the moment a link is followed, so the old page
 * is kept as a still copy: the page area (and the footer) cloned into an opaque layer over the live page,
 * under the header, painted with the page's own paper. Whatever happens beneath it — the loading state, the
 * page streaming in — is not seen. The copy dims to 55% at once (80ms). Once the new page is there (its
 * address is current and no loading state is left in it) the copy is taken away in one step and the new page
 * rises from 55% to full in 160ms: the old page is never laid over the new one.
 *
 * If the new page takes longer, a thin bar under the header grows towards 85% over 1.6s, fills and fades
 * when the page arrives. A second link followed while waiting restarts the bar and only the last page is
 * shown. Filters and sorts keep the same address and are left to their own motion; a note within its
 * course changes only the note column, so the directory beside it stays put. With reduced motion the page
 * is simply swapped; the dim and a still bar remain as a sign of waiting.
 */

const SLOW_AFTER = 60;
/** The old page's dim, and the new page's rise from the same 55%. */
const DIM_MS = 80;
const RISE_MS = 160;
const GIVE_UP_AFTER = 15000;
const EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";

interface Switch {
  target: string;
  /** Whether only the note column is changing (a note within its course). */
  column: boolean;
  dimmed: number;
  overlay: HTMLElement;
  copies: HTMLElement[];
  bar: HTMLElement;
  slow: boolean;
  slowTimer: number;
  frame: number;
  started: number;
}

let current: Switch | null = null;

const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A note within its course changes only the note column; anything else changes the whole page area. */
function areaFor(from: string, to: string): HTMLElement | null {
  const course = (path: string) => /^\/study\/[^/]+(?=\/notes\/)/.exec(path)?.[0];
  if (course(from) && course(from) === course(to)) {
    const column = document.querySelector<HTMLElement>("#main .reading__main");
    if (column) return column;
  }
  return document.getElementById("main");
}

/** The copy must not load anything (iframes would) or carry ids twice; pinned parts stay where they are on screen. */
function copyOf(part: HTMLElement): { copy: HTMLElement; pinned: [HTMLElement, DOMRect][] } {
  const copy = part.cloneNode(true) as HTMLElement;
  copy.removeAttribute("id");
  copy.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
  const frames = [...part.querySelectorAll("iframe, video")];
  copy.querySelectorAll("iframe, video").forEach((element, index) => {
    const box = frames[index]?.getBoundingClientRect();
    const stand = document.createElement("div");
    stand.className = (element as HTMLElement).className;
    stand.style.cssText = `width:${box?.width ?? 0}px;height:${box?.height ?? 0}px;background:var(--soft);border-radius:var(--radius-md)`;
    element.replaceWith(stand);
  });
  const originals = [...part.querySelectorAll<HTMLElement>(".reading__side, .reading__toc")];
  const copies = [...copy.querySelectorAll<HTMLElement>(".reading__side, .reading__toc")];
  const pinned: [HTMLElement, DOMRect][] = [];
  originals.forEach((original, index) => {
    if (getComputedStyle(original).position === "sticky" && copies[index]) pinned.push([copies[index], original.getBoundingClientRect()]);
  });
  return { copy, pinned };
}

/**
 * The copy inside empty stand-ins for the part's ancestors, so rules written against them (".reading .x")
 * and the values they hand down still apply. They take no box of their own.
 */
function withAncestors(part: HTMLElement, copy: HTMLElement): HTMLElement {
  let inner = copy;
  for (let node = part.parentElement; node && node !== document.body; node = node.parentElement) {
    const stand = document.createElement(node.tagName.toLowerCase());
    if (node.className) stand.className = node.className;
    for (const { name, value } of [...node.attributes]) if (name.startsWith("data-")) stand.setAttribute(name, value);
    stand.style.display = "contents";
    stand.append(inner);
    inner = stand;
  }
  return inner;
}

/** The page's paper, laid exactly where the page's own is, so the copy cannot be told from the page. */
function paint(overlay: HTMLElement, bounds: DOMRect) {
  const body = getComputedStyle(document.body);
  const attachments = body.backgroundAttachment.split(",").map(value => value.trim());
  const positions = body.backgroundPosition.split(",").map(value => value.trim());
  overlay.style.backgroundColor = body.backgroundColor;
  overlay.style.backgroundImage = body.backgroundImage;
  overlay.style.backgroundSize = body.backgroundSize;
  overlay.style.backgroundRepeat = body.backgroundRepeat;
  overlay.style.backgroundPosition = positions.map((position, index) => {
    if (attachments[index] === "fixed") return `calc(${position.split(" ")[0]} - ${bounds.left}px) calc(${position.split(" ")[1] ?? "0px"} - ${bounds.top}px)`;
    const [x = "0px", y = "0px"] = position.split(" ");
    return `calc(${x} - ${window.scrollX + bounds.left}px) calc(${y} - ${window.scrollY + bounds.top}px)`;
  }).join(", ");
}

function headerBottom(): number {
  const header = document.querySelector(".site-header");
  return Math.max(0, header ? header.getBoundingClientRect().bottom : 0);
}

function start(from: string, target: string) {
  if (current) {
    // Another link while waiting: only the last page is faded to, and the bar begins again.
    current.target = target;
    current.started = performance.now();
    if (current.slow) grow(current.bar);
    return;
  }
  const area = areaFor(from, target);
  if (!area) return;
  const top = headerBottom();
  const column = area.id !== "main";
  const box = area.getBoundingClientRect();
  const bounds = new DOMRect(column ? box.left : 0, top, column ? box.width : window.innerWidth, Math.max(0, window.innerHeight - top));
  const overlay = document.createElement("div");
  overlay.className = "page-switch";
  overlay.setAttribute("aria-hidden", "true");
  overlay.inert = true;
  overlay.style.cssText = `left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px`;
  paint(overlay, bounds);
  const footer = document.querySelector<HTMLElement>(".site-footer");
  const parts = [area, ...(footer && !area.contains(footer) ? [footer] : [])];
  const copies: HTMLElement[] = [];
  const pinned: [HTMLElement, DOMRect][] = [];
  for (const part of parts) {
    const rect = part.getBoundingClientRect();
    if (rect.bottom < bounds.top || rect.top > bounds.bottom) continue;
    const made = copyOf(part);
    const holder = document.createElement("div");
    holder.className = "page-switch__part";
    holder.style.cssText = `left:${rect.left - bounds.left}px;top:${rect.top - bounds.top}px;width:${rect.width}px`;
    made.copy.style.margin = "0";
    holder.append(withAncestors(part, made.copy));
    overlay.append(holder);
    copies.push(holder);
    pinned.push(...made.pinned);
  }
  const bar = document.createElement("div");
  bar.className = "page-switch__bar";
  bar.setAttribute("aria-hidden", "true");
  bar.style.top = `${top}px`;
  // A copy still fading from the last move stays on top until it has gone; this one, of the page now under it, waits beneath.
  const fading = document.querySelector(".page-switch");
  if (fading) fading.before(overlay); else document.body.append(overlay);
  document.body.append(bar);
  // A pinned column is drawn where it stood on screen, not where it would fall in a page that does not scroll.
  for (const [element, was] of pinned) {
    element.style.position = "relative";
    element.style.top = "0px";
    const now = element.getBoundingClientRect();
    element.style.top = `${was.top - now.top}px`;
  }
  document.documentElement.dataset.pageSwitch = "";
  const entry: Switch = { target, column, dimmed: performance.now(), overlay, copies, bar, slow: false, slowTimer: 0, frame: 0, started: performance.now() };
  current = entry;
  for (const part of copies) {
    if (still()) continue;
    part.animate([{ opacity: 1 }, { opacity: 0.55 }], { duration: DIM_MS, easing: "ease", fill: "forwards" });
  }
  entry.slowTimer = window.setTimeout(() => { if (current === entry) wait(entry); }, SLOW_AFTER);
  const check = () => {
    if (current !== entry) return;
    if (location.pathname === entry.target && !document.querySelector("#main .page-loading, #main [data-page-loading]")) { finish(entry); return; }
    if (performance.now() - entry.started > GIVE_UP_AFTER) { finish(entry); return; }
    entry.frame = requestAnimationFrame(check);
  };
  entry.frame = requestAnimationFrame(check);
}

function grow(bar: HTMLElement) {
  bar.getAnimations().forEach(animation => animation.cancel());
  bar.classList.add("is-on");
  if (still()) { bar.style.width = "85%"; return; }
  bar.style.width = "";
  bar.animate([{ width: "0%" }, { width: "85%" }], { duration: 1600, easing: "cubic-bezier(0.1, 0.7, 0.2, 1)", fill: "forwards" });
}

function wait(entry: Switch) {
  entry.slow = true;
  if (still()) for (const part of entry.copies) part.style.opacity = "0.55";
  grow(entry.bar);
}

function finish(entry: Switch) {
  cancelAnimationFrame(entry.frame);
  clearTimeout(entry.slowTimer);
  current = null;
  const done = () => {
    entry.overlay.remove();
    if (!current) delete document.documentElement.dataset.pageSwitch;
  };
  if (entry.slow && !still()) {
    const width = getComputedStyle(entry.bar).width;
    entry.bar.getAnimations().forEach(animation => animation.cancel());
    entry.bar.animate([{ width, opacity: 1 }, { width: "100%", opacity: 1, offset: 0.375 }, { width: "100%", opacity: 0 }], { duration: 400, easing: "ease-out", fill: "forwards" })
      .finished.then(() => entry.bar.remove(), () => entry.bar.remove());
  } else entry.bar.remove();
  if (still()) { done(); return; }
  // The old page finishes dimming, then goes in one step; the new one rises from where the old one stood.
  const rise = () => {
    done();
    const area = entry.column ? document.querySelector<HTMLElement>("#main .reading__main") : document.getElementById("main");
    const footer = document.querySelector<HTMLElement>(".site-footer");
    for (const part of [area, footer && !area?.contains(footer) ? footer : null]) part?.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: RISE_MS, easing: EASE });
  };
  const left = entry.dimmed + DIM_MS - performance.now();
  if (left > 0) window.setTimeout(rise, left); else rise();
}

/** The link a click is following inside the site, once Next has taken it over; null for anything else. */
function followed(event: MouseEvent): string | null {
  if (!event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return null;
  // A link that opens something in place (the about card on the avatar) is not leaving the page, though it keeps an address for a new tab (M-11).
  if (link.hasAttribute("aria-haspopup")) return null;
  const url = new URL(link.href, location.href);
  // The same address with other filters, sorts or a fragment is not another page.
  if (url.origin !== location.origin || url.pathname === location.pathname) return null;
  return url.pathname;
}

export function PageSwitch() {
  // The page last shown: on Back the address has already changed when the browser says so.
  const shown = useRef("");
  const pathname = usePathname();
  useEffect(() => { shown.current = pathname; }, [pathname]);
  useEffect(() => {
    // Bubbling to the window, so Next's own handler has already decided the click is a client navigation.
    const onClick = (event: MouseEvent) => {
      const target = followed(event);
      if (target) start(location.pathname, target);
    };
    const onPop = () => {
      if (shown.current && location.pathname !== shown.current) start(shown.current, location.pathname);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPop);
    };
  }, []);
  return null;
}
