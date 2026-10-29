"use client";

import Link, { useLinkStatus } from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SocialPlatform } from "../../contracts/social.ts";

interface Choice { value: SocialPlatform; label: string; href: string; icon: ReactNode }

/*
 * The platform switch as the owner chose it (F40, prototype 丙): the list on screen slides away from the
 * chosen platform and fades, then the new cards come in from its side one by one, column by column and row
 * by row; only the first screen takes part. Back the other way it is the mirror image. The values are the
 * prototype's. With reduced motion the old list fades out and the new one fades in.
 */
const OUT = { duration: 300, easing: "cubic-bezier(.5, 0, .75, 0)", shift: 0.6 };
const IN = { duration: 420, easing: "cubic-bezier(.22, .8, .2, 1)", shift: 120, start: 140, column: 45, row: 70 };
/** The new cards start coming in while the old list is still leaving, so the stage is never empty (M-06, 2026-10-20). */
const ARRIVE_AT = 120;
const STILL = { out: 160, in: 200 };

const stillMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Each first-screen card's row, and its column counted from the side the cards come in from. */
function arrivals(pane: HTMLElement, direction: number) {
  const fold = window.innerHeight;
  const cards = [...pane.querySelectorAll<HTMLElement>(".works__grid > li")].map(element => ({ element, box: element.getBoundingClientRect() })).filter(card => card.box.top < fold);
  const tops = [...new Set(cards.map(card => Math.round(card.box.top)))].sort((a, b) => a - b);
  return cards.map(card => {
    const top = Math.round(card.box.top);
    const line = cards.filter(other => Math.round(other.box.top) === top).sort((a, b) => a.box.left - b.box.left);
    const place = line.indexOf(card);
    return { element: card.element, row: tops.indexOf(top), column: direction > 0 ? place : line.length - 1 - place };
  });
}

/**
 * The works page's platform switch and what it shows. Read only the selected platform; immutable
 * image addresses let the browser reuse covers without a second hidden list or image prefetch.
 * While the new list is read, faint cards arrive on the same beat as the real cards.
 */
export function WorksShell({ current, choices, sort, children }: { current: SocialPlatform; choices: Choice[]; sort: ReactNode; children: ReactNode }) {
  const [pressed, setPressed] = useState<SocialPlatform>(current);
  const [phase, setPhase] = useState<"idle" | "leaving" | "arriving">("idle");
  const [shown, setShown] = useState<"list" | "waiting" | null>(null);
  const [switched, setSwitched] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const run = useRef<{ direction: number; leaving: HTMLElement | null; motions: Animation[]; timer: number | undefined }>({ direction: 1, leaving: null, motions: [], timer: undefined });
  const ready = current === pressed;

  // A move the switch did not make (back and forward) shows the arriving platform at once.
  useEffect(() => {
    if (phase === "idle" && !ready) setPressed(current);
  }, [current, phase, ready]);

  // The chosen look slides between the names instead of jumping (motion.css); until it is placed, the link keeps its own.
  useLayoutEffect(() => {
    const place = (animate: boolean) => {
      const box = nav.current?.getBoundingClientRect();
      const link = nav.current?.querySelector<HTMLElement>(`a[data-platform="${pressed}"]`)?.getBoundingClientRect();
      if (!box || !link || !pill.current || !nav.current) return;
      pill.current.style.transition = animate ? "" : "none";
      Object.assign(pill.current.style, { width: `${link.width}px`, height: `${link.height}px`, top: `${link.top - box.top}px`, transform: `translateX(${link.left - box.left}px)` });
      nav.current.dataset.pill = "";
    };
    place(nav.current?.dataset.pill !== undefined);
    const resized = () => place(false);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, [pressed]);

  function leave(target: SocialPlatform) {
    const box = stage.current, now = live.current;
    if (!box || !now) return;
    const state = run.current;
    const order = choices.map(choice => choice.value);
    state.direction = order.indexOf(target) > order.indexOf(pressed) ? 1 : -1;
    window.clearTimeout(state.timer);
    for (const motion of state.motions) motion.cancel();
    state.motions = [];
    const still = stillMotion();
    // A press mid-way stops the leaving list where it is and sends it off towards the new choice.
    let leaving = state.leaving;
    if (leaving) {
      for (const motion of leaving.getAnimations()) { motion.commitStyles(); motion.cancel(); }
    } else {
      leaving = document.createElement("div");
      leaving.className = "works__pane works__pane--leaving";
      leaving.setAttribute("aria-hidden", "true");
      leaving.inert = true;
      leaving.append(...[...now.childNodes].map(node => node.cloneNode(true)));
      box.style.height = `${box.offsetHeight}px`;
      box.append(leaving);
      state.leaving = leaving;
    }
    box.classList.add("is-moving");
    leaving.animate(still ? [{ opacity: 0 }] : [{ transform: `translateX(${-state.direction * box.clientWidth * OUT.shift}px)`, opacity: 0 }],
      { duration: still ? STILL.out : OUT.duration, easing: still ? "linear" : OUT.easing, fill: "forwards" });
    setShown(null);
    setPhase("leaving");
    setSwitched(true);
    state.timer = window.setTimeout(() => setPhase("arriving"), still ? STILL.out : ARRIVE_AT);
  }

  // Once the old list has left: the new cards come in, or faint ones while the list is still being read.
  useLayoutEffect(() => {
    if (phase !== "arriving") return;
    const box = stage.current, now = live.current, state = run.current;
    if (!box || !now) return;
    const next = ready ? "list" : "waiting";
    if (shown === next) return;
    const replacing = shown === "waiting";
    setShown(next);
    // The area grows or shrinks to the new list as the cards arrive.
    box.style.height = `${now.offsetHeight}px`;
    const motions = stillMotion() || replacing
      // Real cards take the faint ones' places without sliding again; with reduced motion everything only fades.
      ? [now.animate([{ opacity: 0 }, { opacity: 1 }], { duration: STILL.in, fill: "backwards" })]
      : arrivals(now, state.direction).map(({ element, row, column }) => element.animate(
        [{ transform: `translateX(${state.direction * IN.shift}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }],
        { duration: IN.duration, delay: IN.start + column * IN.column + row * IN.row, easing: IN.easing, fill: "backwards" },
      ));
    state.motions = motions;
    void Promise.all(motions.map(motion => motion.finished)).then(() => {
      if (state.motions !== motions) return;
      state.motions = [];
      state.leaving?.remove();
      state.leaving = null;
      if (next === "waiting") return;
      box.classList.remove("is-moving");
      box.style.height = "";
      setShown(null);
      setPhase("idle");
    }, () => {});
  }, [phase, ready, shown]);

  const content = ready || phase === "idle" ? children : <WorksWaiting platform={pressed} />;
  return (
    <>
      <header className="page-head library__head">
        <h1>作品</h1>
        {/* The platforms and the order share the title's row, as the other sections put their status beside it (W-03). */}
        <div className="works__tools">
          <nav ref={nav} className="segmented works__platforms" aria-label="按平台">
            <span ref={pill} className="works__pill" aria-hidden="true" />
            {choices.map(choice => (
              <Link key={choice.value} href={choice.href} prefetch={false} data-platform={choice.value}
                aria-current={choice.value === pressed ? "true" : undefined}
                onClick={event => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0 || choice.value === pressed) return;
                  leave(choice.value);
                  setPressed(choice.value);
                }}>
                {choice.icon}{choice.label}
                {/* Another move pressed while this platform was on its way (the order, the header's 作品, a search) takes
                    its place, and this platform will never come: the switch goes back to what is on screen. */}
                <MoveEnded onEnd={() => { if (choice.value === pressed && current !== pressed) setPressed(current); }} />
              </Link>
            ))}
          </nav>
          {/* The order stays through a switch, so the row of buttons never shifts (F40). */}
          {sort}
        </div>
      </header>
      <div ref={stage} className="works__stage" data-switched={switched ? "" : undefined}>
        <div ref={live} className="works__pane" style={phase === "leaving" ? { visibility: "hidden" } : undefined}>{content}</div>
      </div>
    </>
  );
}

/**
 * Calls `onEnd` once the move its link started is over: the page arrived, or another move took its place.
 * A move that arrives ends in the same render as the new page, so the switch already reads the platform as arrived.
 */
function MoveEnded({ onEnd }: { onEnd: () => void }) {
  const { pending } = useLinkStatus();
  const latest = useRef(onEnd);
  useEffect(() => { latest.current = onEnd; });
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !pending) latest.current();
    was.current = pending;
  }, [pending]);
  return null;
}

/** Faint cards in a platform's shape and row, while its list is on the way. */
export function WorksWaiting({ platform }: { platform: SocialPlatform }) {
  const shape = platform === "bilibili" ? "wide" : "tall";
  return (
    <section className="works__group" role="status" aria-label="正在加载作品">
      <ul className={`works__grid works__grid--${platform}`} aria-hidden="true">
        {Array.from({ length: platform === "bilibili" ? 8 : 10 }, (_, index) => (
          <li key={index}>
            <div className={`works-card works-card--${shape}`}>
              <span className="skeleton works-card__frame" />
              <span className="skeleton" style={{ width: "72%", height: 12, marginTop: 6 }} />
              <span className="skeleton" style={{ width: "44%", height: 10 }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
