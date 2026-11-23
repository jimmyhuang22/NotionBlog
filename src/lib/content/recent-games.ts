import type { Game } from "../../../contracts/content.ts";
import type { ContentRepository } from "../../../contracts/repository.ts";
import { compareContent } from "./website.ts";

const RECENT_GAMES = 8;
const MAX_LEGACY_PAGES = 12;

export async function readRecentGamesFrom(repository: ContentRepository, timeZone: string): Promise<Game[]> {
  const games: Game[] = [];
  if (repository.readSnapshot) {
    const { records } = await repository.readSnapshot(["game"], false);
    for (const { item } of records) {
      if (item.kind === "game") games.push(item);
    }
  } else {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LEGACY_PAGES; page++) {
      const { items, nextCursor, hasMore } = await repository.list("game", { limit: 50, ...(cursor ? { cursor } : {}) });
      games.push(...items);
      if (!hasMore || !nextCursor) break;
      cursor = nextCursor;
    }
  }

  return games.filter(game => game.lastPlayedDate?.start)
    .sort((a, b) => b.lastPlayedDate!.start.localeCompare(a.lastPlayedDate!.start)
      || compareContent(a, b, "date-desc", timeZone))
    .slice(0, RECENT_GAMES);
}
