import "server-only";
import { cache } from "react";
import type { Game } from "../../contracts/content.ts";
import { contentRepository } from "./content/index.ts";

/** Enough pages of fifty for the whole game library several times over; a longer one shows its most recent pages' games. */
const MOST_PAGES = 12;
export const RECENT_GAMES = 8;

/**
 * The games most recently played on a linked platform, newest first, for 最近在玩 (the owner's pick 甲, 2026-11-23).
 * The list endpoint orders games by the owner's own dates, not by last play, so this reads the list through and
 * sorts here. A game with no platform play recorded is not in it. One read per request.
 */
export const readRecentGames = cache(async (): Promise<Game[]> => {
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
});
