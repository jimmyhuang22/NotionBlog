import type { Game } from "../../contracts/content.ts";
import { readRecentGames } from "@/lib/content";
import { RecentGames, RecentGamesFailed } from "./recent-games";

const KEEP_MS = 5 * 60_000;
let kept: { at: number; games: Promise<Game[]> } | null = null;

/**
 * The row's games, kept on this server for five minutes (the owner's call, 2026-11-23): a status, year or order
 * switch re-renders the page, and React holds the switch until the row is read again, so without the keep every
 * switch waited about 0.5 s on it (0.7 s against 0.2 s for books, live). A change to the games, a withdrawal
 * included, reaches the row at most five minutes late. A failed read is not kept.
 */
function keptRecentGames(): Promise<Game[]> {
  const now = Date.now();
  if (kept && now - kept.at < KEEP_MS) return kept.games;
  const entry = { at: now, games: readRecentGames() };
  kept = entry;
  entry.games.catch(() => { if (kept === entry) kept = null; });
  return entry.games;
}

/**
 * 最近在玩 as its own streamed part of the games page: it reads the whole game list, so the page sends the library
 * first and this fills in when ready, instead of the whole page waiting on it (measured on the live site,
 * 2026-11-23: 1.4 s for the page against 0.2 s for books). A failure here says so, with a way to try again, and
 * leaves the library alone.
 */
export async function RecentGamesSection({ timeZone }: { timeZone: string }) {
  const games = await keptRecentGames().catch(() => null);
  if (games === null) return <RecentGamesFailed />;
  if (!games.length) return null;
  const thisYear = Number(new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(new Date()));
  return <RecentGames games={games} timeZone={timeZone} thisYear={thisYear} />;
}
