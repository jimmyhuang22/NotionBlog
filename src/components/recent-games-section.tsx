import { readRecentGames } from "@/lib/recent-games";
import { RecentGames } from "./recent-games";

/**
 * 最近在玩 as its own streamed part of the games page: it reads the whole game list, so the page sends the library
 * first and this fills in when ready, instead of the whole page waiting on it (measured on the live site,
 * 2026-11-23: 1.4 s for the page against 0.2 s for books). A failure here says so and leaves the library alone.
 */
export async function RecentGamesSection({ timeZone }: { timeZone: string }) {
  const games = await readRecentGames().catch(() => null);
  if (games === null) return <p className="notice recent-games__notice" role="status">最近在玩暂时读不到，下面的游戏库不受影响。</p>;
  if (!games.length) return null;
  const thisYear = Number(new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(new Date()));
  return <RecentGames games={games} timeZone={timeZone} thisYear={thisYear} />;
}

/** The stage's place, held while it is read: its heading and its height, nothing drawn that could flash. */
export function RecentGamesWaiting() {
  return (
    <section className="recent-games recent-games--waiting" aria-label="最近在玩" aria-busy="true">
      <h2 className="recent-games__head">最近在玩</h2>
      <div className="recent-games__track" />
      <div className="recent-games__info" />
    </section>
  );
}
