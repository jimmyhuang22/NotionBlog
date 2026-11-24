"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { GamePlatformCategory } from "../../contracts/content.ts";
import { GamePlatformIconMark } from "./game-tag";
import { LinkPending } from "./link-pending";
import { Segments } from "./scrolling-segments";

export interface GameStatusChoice { value: string; label: string; href: string }
export interface GamePlatformChoice { value: GamePlatformCategory | null; label: string; count: number; href: string }

/**
 * What the games list holds, set under the stage (丙, 2026-11-24): the statuses as written tabs, 通关 first chosen,
 * and beside them the platforms as a lifted strip with each one's count (丙), all of them counted under the chosen
 * status, whatever year or platform is chosen (handoff 22, 2026-11-25). A platform with no games is left out unless
 * it is the one chosen. The order switch is gone. When the row has scrolled out of sight, the same choices ride along
 * in a glass dock at the bottom of the screen; on a phone the dock keeps the platforms only. A choice changes the list
 * in place, the page not jumping to its top.
 */
export function GameTools({ statuses, current, platforms, platform }: {
  statuses: GameStatusChoice[]; current: string;
  /** Null until the server counts the platforms: no strip is drawn. */
  platforms: GamePlatformChoice[] | null; platform: GamePlatformCategory | null;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const element = row.current;
    if (!element || !("IntersectionObserver" in window)) return;
    const watch = new IntersectionObserver(([entry]) => setDocked(!entry!.isIntersecting && entry!.boundingClientRect.top < 0));
    watch.observe(element);
    return () => watch.disconnect();
  }, []);
  // A choice keeps the page where it is and only the list changes (the owner, 2026-11-25). From the dock, far down
  // the old list, the page glides back to where the list starts, so the new one is seen from its top.
  const toList = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target as Element).closest("a[href]") || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const element = row.current;
    if (!element) return;
    const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 0;
    const top = element.getBoundingClientRect().top + window.scrollY - header - 16;
    if (window.scrollY > top) window.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const statusLinks = statuses.map(choice => (
    <Link key={choice.value} href={choice.href} scroll={false} aria-current={choice.value === current ? "true" : undefined}>{choice.label}<LinkPending /></Link>
  ));
  const platformLinks = platforms?.map(choice => (
    <Link key={choice.value ?? "all"} href={choice.href} scroll={false} aria-current={choice.value === platform ? "true" : undefined}>
      {choice.value ? <GamePlatformIconMark icon={choice.value} /> : null}
      <span className="game-tools__name">{choice.label}</span>
      <small className="game-tools__count">{choice.count}<span className="visually-hidden"> 款</span></small>
      <LinkPending />
    </Link>
  ));
  return (
    <>
      <div ref={row} className="game-tools">
        <Segments label="按状态筛选" current={current} variant="tabs">{statusLinks}</Segments>
        {platformLinks ? <Segments label="按平台筛选" current={platform ?? "all"} variant="lift">{platformLinks}</Segments> : null}
      </div>
      <div className="game-dock" data-up={docked ? "" : undefined} inert={!docked} onClick={toList}>
        <div className="game-dock__statuses"><Segments label="按状态筛选" current={current}>{statusLinks}</Segments></div>
        {platformLinks ? <><span className="game-dock__rule" aria-hidden="true" /><Segments label="按平台筛选" current={platform ?? "all"} variant="lift">{platformLinks}</Segments></> : null}
      </div>
    </>
  );
}
