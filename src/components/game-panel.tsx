"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { readTrophyAnchor, type TrophySet } from "../lib/game-trophies.ts";
import { TrophySetBody, TrophyTabs } from "./game-trophies";
import { TrophyPlatform } from "./trophy-marks";

type View = "notes" | "trophies";

/**
 * A game's write-up and its trophies in one card beside the record column (甲, 2026-11-24): the card's head is the
 * switch "游玩感受 ｜ 奖杯", the write-up first whatever its length (the owner's 2). With the trophies showing, the
 * platform switch stands at the right end of the same head. Only one of the two: its name is the head, no switch.
 *
 * The address keeps the choice ("#trophies", "#trophies-ps5"), so a link or the back button opens the same tab; a
 * link to it elsewhere on the page (the record card's platforms) switches here and brings the card into view. Both
 * parts stay in the page while hidden, so a trophy list opened to "全部" is still open on coming back.
 */
export function GamePanel({ notes, sets, anchors, spanInStrip }: { notes: ReactNode; sets: TrophySet[]; anchors: string[]; spanInStrip: boolean }) {
  // Only sets the backend sent in full have a tab; the record card's summary covers the rest.
  const full = sets.flatMap((set, index) => set.trophies?.length ? [{ set, anchor: anchors[index]! }] : []);
  const hasNotes = notes !== null && notes !== undefined && notes !== false;
  const [view, setView] = useState<View>(hasNotes ? "notes" : "trophies");
  const [chosen, setChosen] = useState(0);
  const base = useId();
  const card = useRef<HTMLElement>(null);
  const fullAnchors = full.map(entry => entry.anchor).join(" ");

  useEffect(() => {
    if (!fullAnchors) return;
    const follow = () => {
      const asked = readTrophyAnchor(window.location.hash, fullAnchors.split(" "));
      if (!asked) return;
      setView("trophies");
      if (asked.set !== null) setChosen(asked.set);
      const box = card.current?.getBoundingClientRect();
      if (box && (box.top < 0 || box.top > window.innerHeight * 0.6)) card.current!.scrollIntoView({ block: "start" });
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [fullAnchors]);

  if (!hasNotes && !full.length) return null;
  const both = hasNotes && full.length > 0;
  const current = full.length ? full[Math.min(chosen, full.length - 1)]! : null;
  const ids = { notesTab: `${base}-tn`, trophyTab: `${base}-tt`, notes: `${base}-pn`, trophies: `${base}-pt`, title: `${base}-h` };

  // The address follows the choice without adding a step to the history.
  const show = (next: View, set = chosen) => {
    setView(next);
    setChosen(set);
    const hash = next === "trophies" ? `#${full.length > 1 ? full[set]!.anchor : "trophies"}` : "";
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next: View = view === "notes" ? "trophies" : "notes";
    show(next);
    document.getElementById(next === "notes" ? ids.notesTab : ids.trophyTab)?.focus();
  };

  return (
    <section ref={card} className="card game-card game-panel" aria-labelledby={both ? undefined : ids.title} aria-label={both ? "游玩感受与奖杯" : undefined}>
      <div className="game-panel__head">
        {both ? (
          <div className="game-panel__tabs" role="tablist" aria-label="游玩感受与奖杯" onKeyDown={onKey}>
            <button type="button" role="tab" id={ids.notesTab} aria-controls={ids.notes} aria-selected={view === "notes"} tabIndex={view === "notes" ? 0 : -1} onClick={() => show("notes")}>游玩感受</button>
            <button type="button" role="tab" id={ids.trophyTab} aria-controls={ids.trophies} aria-selected={view === "trophies"} tabIndex={view === "trophies" ? 0 : -1} onClick={() => show("trophies")}>奖杯</button>
          </div>
        ) : <h2 id={ids.title} className="game-panel__title">{hasNotes ? "游玩感受" : "奖杯"}</h2>}
        {view === "trophies" && current ? (full.length > 1
          ? <TrophyTabs sets={full.map(entry => entry.set)} chosen={chosen} onChoose={index => show("trophies", index)} ids={{ tab: index => `${base}-p${index}`, panel: ids.trophies }} />
          : <span className="game-panel__platform"><TrophyPlatform platform={current.set.platform} /></span>) : null}
      </div>
      {hasNotes ? <div id={ids.notes} role={both ? "tabpanel" : undefined} aria-labelledby={both ? ids.notesTab : undefined} hidden={view !== "notes"}>{notes}</div> : null}
      {current ? (
        <div id={ids.trophies} role={both || full.length > 1 ? "tabpanel" : undefined} aria-labelledby={full.length > 1 ? `${base}-p${chosen}` : both ? ids.trophyTab : undefined} hidden={view !== "trophies"}>
          <TrophySetBody key={current.set.id} set={current.set} spanInStrip={spanInStrip && full.length === 1} />
        </div>
      ) : null}
    </section>
  );
}
