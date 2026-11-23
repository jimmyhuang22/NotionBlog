import "server-only";
import { cache } from "react";
import type { Game } from "../../contracts/content.ts";
import { contentRepository } from "./content/index.ts";

/** Enough pages of fifty for the whole game library several times over; a longer one shows its most recent pages' games. */
const MOST_PAGES = 12;
export const RECENT_GAMES = 8;

/** How long one read of the list is reused: a status, year or order chosen within it gets the stage at once. Last play changes at most a few times a day. */
const KEEP_MS = 5 * 60_000;
let kept: { at: number; games: Promise<Game[]> } | null = null;

async function readThrough(): Promise<Game[]> {
  const games: Game[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MOST_PAGES; page++) {
    const { items, nextCursor, hasMore } = await contentRepository.list("game", { limit: 50, ...(cursor ? { cursor } : {}) });
    games.push(...items);
    if (!hasMore || !nextCursor) break;
    cursor = nextCursor;
  }
  return games.filter(game => game.lastPlayedDate?.start)
    .sort((a, b) => b.lastPlayedDate!.start.localeCompare(a.lastPlayedDate!.start))
    .slice(0, RECENT_GAMES);
}

/**
 * The games most recently played on a linked platform, newest first, for 最近在玩 (the owner's pick 甲, 2026-11-23).
 * The list endpoint orders games by the owner's own dates, not by last play, so this reads the list through (seven
 * pages in November 2026, about 1.2 s on the live site) and sorts here. One read serves this server for five minutes, so
 * choosing a status, a year or an order does not wait on it again; a failed read is not kept. A game with no platform
 * play recorded is not in it.
 */
export const readRecentGames = cache((): Promise<Game[]> => {
  const now = Date.now();
  if (kept && now - kept.at < KEEP_MS) return kept.games;
  const games = readThrough();
  const entry = { at: now, games };
  kept = entry;
  games.catch(() => { if (kept === entry) kept = null; });
  return games;
});
