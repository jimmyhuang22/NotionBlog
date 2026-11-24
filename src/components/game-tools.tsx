"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LinkPending } from "./link-pending";
import { Segments } from "./scrolling-segments";

export interface GameStatusChoice { value: string; label: string; href: string }

/**
 * What the games list holds, set under the stage (丙, 2026-11-24): the statuses as written tabs, 通关 first chosen.
 * The order switch is gone; the platforms join here once the list can be narrowed by them (Codex's handoff 22).
 * When the row has scrolled out of sight, the same choice rides along in a glass dock at the bottom of the screen.
 */
export function GameTools({ statuses, current }: { statuses: GameStatusChoice[]; current: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const element = row.current;
    if (!element || !("IntersectionObserver" in window)) return;
    const watch = new IntersectionObserver(([entry]) => setDocked(!entry!.isIntersecting && entry!.boundingClientRect.top < 0));
    watch.observe(element);
    return () => watch.disconnect();
  }, []);
  const links = statuses.map(choice => (
    <Link key={choice.value} href={choice.href} aria-current={choice.value === current ? "true" : undefined}>{choice.label}<LinkPending /></Link>
  ));
  return (
    <>
      <div ref={row} className="game-tools">
        <Segments label="按状态筛选" current={current} variant="tabs">{links}</Segments>
      </div>
      <div className="game-dock" data-up={docked ? "" : undefined} inert={!docked}>
        <Segments label="按状态筛选" current={current}>{links}</Segments>
      </div>
    </>
  );
}
