"use client";

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";
import { PageLoading } from "./page-loading";
import { SectionWaiting, waitingSections } from "./section-waiting";
import { sectionLoadingTitle } from "../lib/section-loading.ts";

/**
 * Section roots enter their own loading frame immediately (2026-11-03). A short
 * 60ms grace avoids flashing a skeleton for an already cached page. The frame
 * gives way as soon as Next commits the route, including its loading boundary;
 * content and images then arrive normally. It never waits for a complete list.
 *
 * Detail pages and notes retain F45's dim-then-swap; a note within its course
 * changes only the reading column. Same-path filters/sorts keep their own motion.
 */

const SLOW_AFTER = 60;
/** The old page's dim, and the new page's rise from the same 55%. */
const DIM_MS = 80;
const RISE_MS = 160;
/** A section's list developing under its title once it has arrived. */
const ARRIVE_MS = 220;
const GIVE_UP_AFTER = 15000;
const EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";

interface Switch {
  progressive?: boolean;
  restore?: () => void;
  target: string;
  /** Whether only the note column is changing (a note within its course). */
  column: boolean;
  dimmed: number;
  overlay: HTMLElement;
  copies: HTMLElement[];
  bar: HTMLElement;
  slow: boolean;
  slowTimer: number;
  /** A section frame's own give-up: a move that never lands must not leave the page covered and inert. */
  giveUpTimer?: number;
  frame: number;
  started: number;
}

let current: Switch | null = null;
let committedPath = "";
let loadingTemplate: HTMLElement | null = null;
let loadingTemplates: HTMLElement | null = null;

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

/** Takes a switch away at once, with no rise: another one that covers a different area replaces it. */
function drop(entry: Switch) {
  cancelAnimationFrame(entry.frame);
  clearTimeout(entry.slowTimer);
  clearTimeout(entry.giveUpTimer);
  entry.overlay.remove();
  entry.bar.remove();
  entry.restore?.();
  if (current === entry) current = null;
}

/** Show a section before its response arrives, then let Next stream its real
 * loading boundary/content. Never keep an opaque old-page copy over that boundary. */
function enterSection(target: string, title: string) {
  // The section's own drawing where it has one (M-15), so the frame and the loading state after it are one shape.
  const template = loadingTemplates?.querySelector<HTMLElement>(`[data-for="${CSS.escape(target)}"] > *`) ?? loadingTemplate;
  if (!template) return false;
  const immediate = current?.progressive && !current.overlay.hidden;
  if (current) drop(current);
  if (location.pathname === target && committedPath === target) return true;
  const top = headerBottom();
  const overlay = document.createElement("div");
  overlay.className = "page-switch";
  overlay.dataset.sectionPending = target;
  overlay.setAttribute("role", "main");
  overlay.style.pointerEvents = "auto";
  overlay.hidden = true;
  const shell = template.cloneNode(true) as HTMLElement;
  shell.setAttribute("aria-label", `正在加载${title}`);
  const header = document.createElement("header");
  header.className = "page-head";
  const heading = document.createElement("h1");
  heading.textContent = title;
  header.append(heading);
  const slot = shell.querySelector("[data-loading-title]");
  if (slot) slot.replaceWith(heading); else shell.querySelector("[data-loading-heading]")?.replaceWith(header);
  overlay.append(shell);
  document.body.append(overlay);
  const bar = document.createElement("div");
  bar.className = "page-switch__bar";
  bar.style.top = `${top}px`;
  bar.setAttribute("aria-hidden", "true");
  document.body.append(bar);
  const place = () => {
    const nextTop = headerBottom();
    const bounds = new DOMRect(0, nextTop, document.documentElement.clientWidth, Math.max(0, window.innerHeight - nextTop));
    Object.assign(overlay.style, { left: "0px", top: `${nextTop}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    bar.style.top = `${nextTop}px`;
    paint(overlay, bounds);
  };
  place();
  const theme = new MutationObserver(place);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-skin", "style"] });
  window.addEventListener("resize", place);
  const hidden: { element: HTMLElement; aria: string | null; inert: boolean }[] = [];
  const entry: Switch = { target, progressive: true, column: false, dimmed: 0, overlay, copies: [], bar,
    slow: false, slowTimer: 0, frame: 0, started: performance.now(), restore() {
      theme.disconnect();
      window.removeEventListener("resize", place);
      for (const { element, aria, inert } of hidden) {
        if (aria === null) element.removeAttribute("aria-hidden"); else element.setAttribute("aria-hidden", aria);
        element.inert = inert;
      }
    } };
  current = entry;
  // As detail pages give up after GIVE_UP_AFTER: if the section has not landed by then, the frame goes and the
  // page left is usable again. Should the move land later, it simply replaces that page.
  entry.giveUpTimer = window.setTimeout(() => { if (current === entry) drop(entry); }, GIVE_UP_AFTER);
  const show = () => {
    if (current !== entry) return;
    // The frame's faint shapes hold back a moment (globals.css); the loading state that takes over carries on from this clock.
    overlay.style.setProperty("--waited", `${Math.round(performance.now() - entry.started)}ms`);
    for (const element of [document.getElementById("main"), document.querySelector<HTMLElement>(".site-footer")]) {
      if (!element) continue;
      hidden.push({ element, aria: element.getAttribute("aria-hidden"), inert: element.inert });
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    overlay.hidden = false;
    wait(entry);
  };
  // A cached page can commit in this brief interval without flashing a skeleton.
  if (immediate) show(); else entry.slowTimer = window.setTimeout(show, SLOW_AFTER);
  return true;
}

/**
 * A section frame has given way to its page. What stands under the title develops in place (2026-11-13): the
 * loading state first carries on the frame's clock, so its shapes neither blink nor start over, and the list
 * that replaces it fades in rather than cutting in. The title and the tools beside it do not move or fade.
 */
function arrive(entry: Switch) {
  const main = document.getElementById("main");
  if (!main) return;
  const shown = !entry.overlay.hidden;
  if (shown) main.style.setProperty("--waited", `${Math.round(performance.now() - entry.started)}ms`); else main.style.removeProperty("--waited");
  if (!shown || still() || entry.target === "/") return;
  const waiting = () => [...main.querySelectorAll(".page-loading, [data-page-loading]")].some(element => !element.closest("[data-switch-template]"));
  const develop = () => {
    for (const part of main.querySelectorAll<HTMLElement>(".wrap > :not(.page-head)")) {
      if (part.closest("[data-switch-template]")) continue;
      part.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ARRIVE_MS, easing: "ease-out" });
    }
  };
  if (!waiting()) { develop(); return; }
  const watch = new MutationObserver(() => {
    if (waiting()) return;
    watch.disconnect();
    window.clearTimeout(end);
    develop();
  });
  const end = window.setTimeout(() => watch.disconnect(), GIVE_UP_AFTER);
  watch.observe(main, { childList: true, subtree: true });
}

function start(from: string, target: string) {
  const title = sectionLoadingTitle(target);
  if (title && enterSection(target, title)) return;
  // A detail/note followed while a section is pending must start from the live area.
  if (current?.progressive) drop(current);
  if (current) {
    // Another link while waiting: only the last page is faded to, and the bar begins again. A note within its
    // course covers only its column; a move on to another page must cover the whole page area, so it starts over.
    // Back to the page still shown keeps the copy that is up: whatever is loading beneath it stays covered.
    const column = areaFor(from, target)?.id !== "main";
    if (target === from || column === current.column) {
      current.target = target;
      current.started = performance.now();
      if (current.slow) grow(current.bar);
      return;
    }
    drop(current);
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
  const entry: Switch = { target, column, dimmed: performance.now(), overlay, copies, bar, slow: false, slowTimer: 0, frame: 0, started: performance.now() };
  current = entry;
  for (const part of copies) {
    if (still()) continue;
    part.animate([{ opacity: 1 }, { opacity: 0.55 }], { duration: DIM_MS, easing: "ease", fill: "forwards" });
  }
  entry.slowTimer = window.setTimeout(() => { if (current === entry) wait(entry); }, SLOW_AFTER);
  const check = () => {
    if (current !== entry) return;
    const loading = [...document.querySelectorAll("#main .page-loading, #main [data-page-loading]")]
      .some(element => !element.closest("[data-switch-template]"));
    if (location.pathname === entry.target && !loading) { finish(entry); return; }
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
  const done = () => entry.overlay.remove();
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

/**
 * The link a click is following inside the site, once Next has taken it over; null for anything else. While a
 * page is on its way the address bar still shows the page left, so a link back to it is a move too (to it).
 */
function followed(event: MouseEvent): string | null {
  if (!event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return null;
  // A link that opens something in place (the about card on the avatar) is not leaving the page, though it keeps an address for a new tab (M-11).
  if (link.hasAttribute("aria-haspopup")) return null;
  const url = new URL(link.href, location.href);
  // The same address with other filters, sorts or a fragment is not another page, unless another page is on its way.
  if (url.origin !== location.origin || (url.pathname === location.pathname && !current)) return null;
  return url.pathname;
}

/**
 * For a move made in code (router.push) rather than by a click on a link, such as Enter in quick search:
 * the same still copy and bar as a followed link. Call it just before the push. Another address with the
 * same path (other filters, a fragment) is not another page, as for a click.
 */
export function announceMove(href: string) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin || (url.pathname === location.pathname && !current)) return;
  start(location.pathname, url.pathname);
}

export function PageSwitch() {
  // The page last shown: on Back the address has already changed when the browser says so.
  const shown = useRef("");
  const template = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useLayoutEffect(() => {
    shown.current = pathname;
    committedPath = pathname;
    if (current?.progressive && (current.target === pathname ||
        pathname === "/content-not-found" || pathname === "/content-unavailable")) {
      const entry = current;
      if (entry.target === pathname) arrive(entry);
      drop(entry);
    } else if (!current) document.getElementById("main")?.style.removeProperty("--waited");
  }, [pathname]);
  useEffect(() => {
    const own = template.current?.firstElementChild as HTMLElement | null;
    const all = template.current;
    loadingTemplate = own;
    loadingTemplates = all;
    return () => {
      if (loadingTemplate === own) loadingTemplate = null;
      if (loadingTemplates === all) loadingTemplates = null;
      if (current?.progressive) drop(current);
    };
  }, []);
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
  // No hidden h1: the heading is inserted only into the visible pending shell.
  return (
    <div ref={template} hidden data-switch-template aria-hidden="true">
      <PageLoading title="" />
      {waitingSections.map(path => <div key={path} data-for={path}>{SectionWaiting({ path, heading: <span data-loading-title /> })}</div>)}
    </div>
  );
}
