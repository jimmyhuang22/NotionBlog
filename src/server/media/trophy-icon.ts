import { ContentServiceError } from "../../../contracts/repository.ts";
import type { PublicationMode } from "../database/publication.ts";
import type { SqlExecutor } from "../database/sql.ts";

export const isTrophyIconId = (id: string) => /^psn-trophy-[0-9a-f]{64}$/.test(id);

export async function trophyIconResponse(db: SqlExecutor, mode: PublicationMode, id: string): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  const missing = () => new Response(null, { status: 404, headers });
  if (!isTrophyIconId(id)) return missing();
  try {
    const { rows: [icon] } = await db.query<{ bytes: Buffer; mime: string }>(
      "SELECT bytes, mime FROM nb_game_trophies_api.read_trophy_icon($1,$2)", [id, mode]);
    if (!icon) return missing();
    return new Response(Uint8Array.from(icon.bytes), { headers: { ...headers, "Content-Type": icon.mime } });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "42883" || code === "3F000") return missing();
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "The trophy icon is unavailable.");
  }
}
