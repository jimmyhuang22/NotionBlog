import { createHash } from "node:crypto";
import { exchangeNpssoForAccessCode, exchangeAccessCodeForAuthTokens, exchangeRefreshTokenForAuthTokens,
  getProfileFromAccountId, getUserPlayedGames, getUserTrophiesForSpecificTitle, getUserTrophyProfileSummary, getUserTitles } from "psn-api";
import type { AuthTokensResponse } from "psn-api";
import { GameSyncError, object, psnRows, required } from "./model.ts";
import { readJson, writeJson } from "./private.ts";

export async function collectPsn(npsso: string, onlineId: string, cachePath: string, account: string) {
  if (!/^[A-Za-z0-9_-]{64}$/.test(npsso) || !onlineId) throw new GameSyncError("LOGIN_REQUIRED");
  const fingerprint = createHash("sha256").update(npsso).digest("hex");
  const cached = await readJson(cachePath);
  let auth: AuthTokensResponse, expiresAt: number, stage = "AUTH";
  try {
    const c = cached ? object(cached) : null;
    if (c?.fingerprint === fingerprint && typeof c.expiresAt === "number" && c.expiresAt > Date.now() + 60000) {
      auth = c.auth as AuthTokensResponse;
      expiresAt = c.expiresAt as number;
    } else if (c?.fingerprint === fingerprint && object(c.auth).refreshToken) {
      auth = await exchangeRefreshTokenForAuthTokens(required(object(c.auth).refreshToken));
      expiresAt = Date.now() + auth.expiresIn * 1000;
    } else {
      auth = await exchangeAccessCodeForAuthTokens(await exchangeNpssoForAccessCode(npsso));
      expiresAt = Date.now() + auth.expiresIn * 1000;
    }
    await writeJson(cachePath, { fingerprint, auth, expiresAt });
    stage = "PROFILE";
    const own = await getUserTrophyProfileSummary(auth, "me");
    const profile = await getProfileFromAccountId(auth, own.accountId);
    if (profile.onlineId.toLowerCase() !== onlineId.toLowerCase() || profile.isMe !== true) {
      throw new GameSyncError("ACCOUNT_MISMATCH");
    }
    stage = "GAMES";
    const titles: unknown[] = [], seen = new Set<number>(); let offset = 0, total: number | null = null;
    for (let page = 0; page < 200; page++) {
      if (seen.has(offset)) throw new GameSyncError("SCOPE_INCOMPLETE"); seen.add(offset);
      const response = await getUserPlayedGames(auth, "me", { limit: 100, offset, categories: "ps4_game,ps5_native_game" });
      if (!Array.isArray(response.titles) || !Number.isSafeInteger(response.totalItemCount) || response.totalItemCount < 0 || response.totalItemCount > 10000) {
        throw new GameSyncError("SCOPE_INCOMPLETE");
      }
      if (total !== null && total !== response.totalItemCount) throw new GameSyncError("SCOPE_INCOMPLETE");
      total = response.totalItemCount; titles.push(...response.titles);
      if (titles.length === total) break;
      if (titles.length > total || !response.titles.length) throw new GameSyncError("SCOPE_INCOMPLETE");
      offset = response.nextOffset ?? offset + response.titles.length;
    }
    if (titles.length !== total) throw new GameSyncError("SCOPE_INCOMPLETE");
    stage = "TROPHIES";
    const bySet = new Map<string, Record<string, unknown>>();
    let trophyOffset = 0, trophyTotal: number | null = null;
    const trophyOffsets = new Set<number>();
    for (let page = 0; page < 100; page++) {
      if (trophyOffsets.has(trophyOffset)) throw new GameSyncError("SCOPE_INCOMPLETE");
      trophyOffsets.add(trophyOffset);
      const data = await getUserTitles(auth, "me", { limit: 800, offset: trophyOffset });
      if (!Array.isArray(data.trophyTitles) || !Number.isSafeInteger(data.totalItemCount) || data.totalItemCount < 0 || data.totalItemCount > 10000) {
        throw new GameSyncError("SCOPE_INCOMPLETE");
      }
      if (trophyTotal !== null && trophyTotal !== data.totalItemCount) throw new GameSyncError("SCOPE_INCOMPLETE");
      trophyTotal = data.totalItemCount;
      for (const t of data.trophyTitles) {
        if (bySet.has(t.npCommunicationId)) throw new GameSyncError("SCOPE_INCOMPLETE");
        bySet.set(t.npCommunicationId, object(t));
      }
      if (bySet.size === trophyTotal) break;
      if (!data.trophyTitles.length || bySet.size > trophyTotal) throw new GameSyncError("SCOPE_INCOMPLETE");
      trophyOffset = data.nextOffset ?? trophyOffset + data.trophyTitles.length;
    }
    if (bySet.size !== trophyTotal) throw new GameSyncError("SCOPE_INCOMPLETE");
    const trophies = new Map<string, Record<string, unknown>[]>();
    for (let index = 0; index < titles.length; index += 5) {
      const ids = titles.slice(index, index + 5).map(t => required(object(t).titleId));
      const response = await getUserTrophiesForSpecificTitle(auth, "me", { npTitleIds: ids.join(",") });
      if (!Array.isArray(response.titles)) throw new GameSyncError("SCOPE_INCOMPLETE");
      for (const t of response.titles) {
        if (!ids.includes(t.npTitleId) || trophies.has(t.npTitleId) || !Array.isArray(t.trophyTitles)) throw new GameSyncError("SCOPE_INCOMPLETE");
        trophies.set(t.npTitleId, t.trophyTitles.map(value => {
        const summary = bySet.get(value.npCommunicationId);
        // Only the complete privacy-aware list can authorize a product, not a partial title lookup.
        return summary ? { ...object(value), ...summary } : { ...object(value), hiddenFlag: undefined };
        }));
      }
    }
    return psnRows(titles, account, new Date().toISOString(), trophies);
  } catch (e) { if (e instanceof GameSyncError) throw e; throw new GameSyncError(`PSN_${stage}_UNAVAILABLE_OR_LOGIN_REQUIRED`); }
}
