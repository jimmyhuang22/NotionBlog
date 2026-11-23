import type { PageObjectResponse } from "@notionhq/client";
import type { GamePlatformPlayTime } from "../../../contracts/content.ts";
import { gameCasePlatformKey, selectGameCasePlatform } from "../../lib/content/game-case.ts";
import { getProperty, getSelect, getValues } from "./properties.ts";

const switchDevices = new Set(["Nintendo Switch", "Nintendo Switch 2", "Nintendo 3DS", "Wii U"]);
const playStationHardware = (value: string): string | null => /^(?:PS|PlayStation )([45])$/iu.exec(value.trim())?.[1] ?? null;

function recordPlatform(provider: string, hardware: string): string | null {
  if (provider === "Steam" && hardware === "PC") return "Steam";
  if (provider === "PSN" && playStationHardware(hardware)) return "PlayStation";
  return provider === "Nintendo" && switchDevices.has(hardware) ? hardware : null;
}

type PlayObservation = { platform: string; hardware: string; minutes: number };

/** The mapped formula uses only the current, confirmed Platform Records relation. */
function readObservations(page: PageObjectResponse, field: string | undefined, platforms: string[]): PlayObservation[] {
  const property = getProperty(page, field);
  const value = property?.type === "formula" && property.formula.type === "string" ? property.formula.string : null;
  if (!value || value.length > 2000) return [];
  const lines = value.split("\n");
  if (lines.length > 24) return [];

  const observed = new Map<string, PlayObservation | null>();
  for (const line of lines) {
    const match = /^([^|\r\n]{1,16})\|([^|\r\n]{1,32})\|(\d{1,12}(?:\.\d{1,18})?)$/u.exec(line);
    if (!match) return [];
    const [, provider, hardware, amount] = match;
    const label = recordPlatform(provider, hardware);
    if (!label) continue;
    const platform = (provider === "PSN" ? platforms.find(name => playStationHardware(name) === playStationHardware(hardware)) : undefined) ??
      platforms.find(name => gameCasePlatformKey(name) === gameCasePlatformKey(label) && !playStationHardware(name));
    if (!platform) continue;
    const key = provider + "|" + hardware;
    observed.set(key, observed.has(key) ? null : { platform, hardware, minutes: Number(amount) });
  }
  return [...observed.values()].filter(row => row !== null);
}

export function readGameCaseFields(page: PageObjectResponse, fields: Readonly<Record<string, string>>, lastPlayedPlatforms: string[] | null) {
  const platforms = getValues(page, fields.platforms);
  const observations = readObservations(page, fields.platformPlayTime, platforms);
  const total = new Map<string, number>();
  for (const row of observations) total.set(row.platform, (total.get(row.platform) ?? 0) + row.minutes);
  const platformPlayTime: GamePlatformPlayTime[] | null = total.size
    ? [...total].map(([platform, minutes]) => ({ platform, time: { value: minutes / 60, unit: "hour" } }))
    : null;
  const platform = selectGameCasePlatform({ platforms, lastPlayedPlatforms, platformPlayTime });
  const artPlatform = getSelect(page, fields.boxArtPlatform);
  let artMatches = Boolean(platform && artPlatform && gameCasePlatformKey(platform) === gameCasePlatformKey(artPlatform));
  if (platform && artPlatform && gameCasePlatformKey(platform) === "playstation") {
    // Exact confirmed edition if known. A broad label alone cannot certify a PS4 or PS5 asset.
    const exact = playStationHardware(platform);
    const played = observations.filter(row => row.platform === platform && row.minutes > 0).sort((a, b) => b.minutes - a.minutes);
    const leading = played[0];
    const uncertain = !exact && leading && leading.minutes === played[1]?.minutes;
    const expected = exact ?? (leading ? playStationHardware(leading.hardware) : null);
    artMatches = artMatches && !uncertain && Boolean(playStationHardware(artPlatform)) &&
      (!expected || expected === playStationHardware(artPlatform));
  }
  return { platforms, platformPlayTime, platform, boxArtProperty: artMatches ? fields.boxArt : undefined };
}

/** Formula values can change while the parent page's edit timestamp stays put. */
export function gameCaseSourceRevision(page: PageObjectResponse, fields: Readonly<Record<string, string>>) {
  if (!fields.boxArt && !fields.platformPlayTime) return null;
  return [fields.platforms, fields.platformPlayTime, fields.lastPlayedDate, fields.lastPlayedPlatforms, fields.boxArtPlatform]
    .map(field => getProperty(page, field));
}
