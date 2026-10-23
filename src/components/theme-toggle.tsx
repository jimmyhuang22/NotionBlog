"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { spreadRadius } from "../lib/spread.ts";
import { DEFAULT_SKIN, isScheme, isSkin, rootAttributes, schemeFor, skinAfter, skinOf, skins, type Scheme, type SkinId, type Transition, currentSkin } from "../lib/skins.ts";


/** Width of the soft edge behind the spreading ink front, as a share of the shorter viewport side. */
const EDGE = 0.14;
let runs = 0;
/** The root marker that selects a transition's rules in globals.css: `data-theme-spread` is `themeSpread` in the dataset. */
const markerOf = (transition: Transition) => `theme${transition[0]!.toUpperCase()}${transition.slice(1)}`;
const markers = skins.map(skin => markerOf(skin.transition));

/**
 * The tab icons follow the system theme through their media queries. Once the visitor has chosen
 * a scheme by hand, both point at that scheme's icon instead, whichever one the browser picks.
 */
function syncIcons() {
  const theme = document.documentElement.dataset.theme;
  if (theme !== "light" && theme !== "dark") return;
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"][href^="/site-icon/"]')) {
    if (link.getAttribute("href") !== `/site-icon/${theme}`) link.href = `/site-icon/${theme}`;
  }
}

function systemScheme(): Scheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function stored(): { skin: SkinId; theme: Scheme | null } {
  try {
    const skin = currentSkin(localStorage.getItem("skin"));
    const theme = localStorage.getItem("theme");
    return { skin: isSkin(skin) ? skin : DEFAULT_SKIN, theme: isScheme(theme) ? theme : null };
  } catch {
    return { skin: DEFAULT_SKIN, theme: null };
  }
}

/**
 * Applies a choice to the root and remembers it. The change arrives the way the chosen skin does:
 * ink spreads from the button, apple comes into focus like frosted glass, the island pops open from the
 * button with a little bounce, y2k grows as a bubble and a sheen of glass sweeps it
 * (globals.css and skins.css). Without view transitions, or when the visitor prefers reduced
 * motion, or when nothing on screen changes (animate is false), it simply switches.
 */
function applyChoice(skin: SkinId, theme: Scheme | null, origin: { x: number; y: number } | null, animate = true) {
  const root = document.documentElement;
  const attributes = rootAttributes(skin, theme);
  const apply = () => {
    if (attributes.skin) root.dataset.skin = attributes.skin; else delete root.dataset.skin;
    if (attributes.theme) root.dataset.theme = attributes.theme; else delete root.dataset.theme;
    try {
      localStorage.setItem("skin", skin);
      if (theme) localStorage.setItem("theme", theme); else localStorage.removeItem("theme");
    } catch { /* private mode: the choice lasts for this page only */ }
    syncIcons();
  };
  if (!animate || typeof document.startViewTransition !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { apply(); return; }
  const marker = markerOf(skinOf(skin).transition);
  // A choice made while the last one is still arriving replaces it: its marker goes too, or the
  // rules of two transitions would both apply to the next one (arrow keys make this an everyday case).
  for (const stale of markers) if (stale !== marker) delete root.dataset[stale];
  const transition = skinOf(skin).transition;
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? 0;
  const edge = transition === "spread" ? Math.min(window.innerWidth, window.innerHeight) * EDGE : 0;
  root.style.setProperty("--spread-x", `${x}px`);
  root.style.setProperty("--spread-y", `${y}px`);
  root.style.setProperty("--spread-edge", `${edge}px`);
  root.style.setProperty("--spread-end", `${spreadRadius(x, y, window.innerWidth, window.innerHeight, edge)}px`);
  root.dataset[marker] = "";
  // Y2K: the new look carries one sheen of glass across once the bubble has opened (globals.css). It leaves on its own.
  document.querySelector(".theme-sheen")?.remove();
  const swap = transition === "bubble" ? () => {
    apply();
    const sheen = document.createElement("div");
    sheen.className = "theme-sheen";
    sheen.setAttribute("aria-hidden", "true");
    sheen.addEventListener("animationend", () => sheen.remove());
    window.setTimeout(() => sheen.remove(), 1600);
    document.body.append(sheen);
  } : apply;
  // A second choice replaces the running transition; only the latest one cleans up.
  const run = ++runs;
  const done = () => {
    if (run !== runs) return;
    delete root.dataset[marker];
    for (const name of ["--spread-x", "--spread-y", "--spread-edge", "--spread-end"]) root.style.removeProperty(name);
  };
  document.startViewTransition(swap).finished.then(done, done);
}

const schemeLabels: Record<Scheme, string> = { light: "浅色", dark: "深色" };
/** How long the "only light" note stays under the light/dark button. */
const HINT_MS = 2400;

const sunIcon = <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="9" cy="9" r="3.2" /><path d="M9 1.8v1.8M9 14.4v1.8M1.8 9h1.8M14.4 9h1.8M3.9 3.9l1.3 1.3M12.8 12.8l1.3 1.3M3.9 14.1l1.3-1.3M12.8 5.2l1.3-1.3" /></svg>;
const moonIcon = <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M15 10.6A6.5 6.5 0 0 1 7.4 3a6.5 6.5 0 1 0 7.6 7.6z" /></svg>;
const paletteIcon = <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2a7 7 0 1 0 0 14c1.1 0 1.6-.7 1.6-1.4 0-1-.9-1.3-.9-2.2 0-.8.6-1.4 1.5-1.4H13a3 3 0 0 0 3-3C16 4.8 12.9 2 9 2z" /><circle cx="5.6" cy="8.4" r=".7" fill="currentColor" stroke="none" /><circle cx="8" cy="5.4" r=".7" fill="currentColor" stroke="none" /><circle cx="11.6" cy="5.8" r=".7" fill="currentColor" stroke="none" /></svg>;

function centre(element: HTMLElement | null) {
  const box = element?.getBoundingClientRect();
  return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
}

/**
 * The header's two appearance controls (user's choice, 2026-10-17). The palette button opens the
 * skins as a radio group, with a switch to let light and dark follow the system again. The
 * light/dark button switches at once, the change spreading from it the way the skin arrives; the
 * first press fixes the choice, until the switch is turned back on. A skin drawn in one scheme
 * keeps the button where it is: pressing it says so in a note underneath and changes nothing.
 */
export function ThemeControls() {
  const [open, setOpen] = useState(false);
  const [skin, setSkin] = useState<SkinId>(DEFAULT_SKIN);
  const [theme, setTheme] = useState<Scheme | null>(null);
  const [system, setSystem] = useState<Scheme>("light");
  const [hint, setHint] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const schemeButton = useRef<HTMLButtonElement>(null);
  const hintTimer = useRef<number | undefined>(undefined);

  // The stored choice is read after mounting so the first render matches the server's.
  useEffect(() => {
    const choice = stored();
    setSkin(choice.skin);
    setTheme(choice.theme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => setSystem(media.matches ? "dark" : "light");
    follow();
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  // Navigation re-renders the head and resets the icon links, so they are put back whenever the head changes.
  useEffect(() => {
    syncIcons();
    const observer = new MutationObserver(syncIcons);
    observer.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => window.clearTimeout(hintTimer.current), []);

  // Escape closes and returns focus; so does a press outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuButton.current?.focus();
    };
    const onDown = (event: PointerEvent) => { if (!group.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open]);

  const current = skinOf(skin);
  const shown = schemeFor(skin, theme, system);
  const fixed = current.schemes.length === 1;

  const chooseSkin = (next: SkinId) => {
    if (next === skin) return;
    setSkin(next);
    applyChoice(next, theme, centre(menuButton.current));
  };
  // The skins are one radio group: Tab lands on the chosen one, and the arrow keys move along the
  // list and choose as they go, wrapping round at either end. Space and Enter stay native clicks,
  // which chooseSkin ignores for the skin already chosen, so a choice never runs twice.
  const onSkinsKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const steps = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
    if (!steps) return;
    event.preventDefault();
    const next = skinAfter(skin, steps);
    chooseSkin(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[skins.findIndex(item => item.id === next)]?.focus();
  };
  const toggleScheme = () => {
    const next: Scheme = shown === "dark" ? "light" : "dark";
    if (!current.schemes.includes(next)) {
      setHint(true);
      window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setHint(false), HINT_MS);
      return;
    }
    setOpen(false);
    setTheme(next);
    applyChoice(skin, next, centre(schemeButton.current));
  };
  // Turning the switch off keeps the scheme on screen and only stops following the system.
  const setFollow = (follow: boolean) => {
    const next = follow ? null : shown;
    setTheme(next);
    applyChoice(skin, next, centre(menuButton.current), schemeFor(skin, next, system) !== shown);
  };

  const schemeLabel = fixed ? `${current.label}只有${schemeLabels[current.schemes[0]!]}` : `换成${schemeLabels[shown === "dark" ? "light" : "dark"]}`;
  return (
    <>
      <div className="theme-menu" ref={group} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
        <button type="button" ref={menuButton} className="icon-button" aria-label="主题" title="主题" aria-haspopup="true" aria-expanded={open} aria-controls="theme-menu-panel" onClick={() => setOpen(!open)}>
          {paletteIcon}
        </button>
        <div id="theme-menu-panel" className="theme-menu__panel" hidden={!open}>
          <p className="theme-menu__title" id="theme-menu-skins">主题</p>
          <div className="theme-menu__group" role="radiogroup" aria-labelledby="theme-menu-skins" onKeyDown={onSkinsKey}>
            {skins.map(item => (
              <button key={item.id} type="button" role="radio" aria-checked={item.id === skin} tabIndex={item.id === skin ? 0 : -1} className={`theme-menu__option theme-menu__option--${item.id}`} onClick={() => chooseSkin(item.id)}>
                <span className="theme-menu__swatch" aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </div>
          {fixed
            ? <p className="theme-menu__note">这套主题只有{schemeLabels[current.schemes[0]!]}。</p>
            : (
              // The whole row is the switch: a label around a button would move focus out of the menu on press and close it.
              <button type="button" role="switch" className="theme-menu__follow" aria-checked={theme === null} onClick={() => setFollow(theme !== null)}>
                明暗跟随系统<span className="theme-menu__switch" aria-hidden="true" />
              </button>
            )}
        </div>
      </div>
      <div className="scheme-toggle">
        <button type="button" ref={schemeButton} className="icon-button" aria-label={schemeLabel} title={schemeLabel} onClick={toggleScheme}>
          {shown === "dark" ? sunIcon : moonIcon}
        </button>
        <span className="scheme-toggle__hint" role="status">{hint ? `${current.label}只有${schemeLabels[current.schemes[0]!]}` : ""}</span>
      </div>
    </>
  );
}
