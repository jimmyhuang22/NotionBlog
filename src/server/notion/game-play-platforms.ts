import type { PageObjectResponse } from "@notionhq/client";
import type { DateRange } from "../../../contracts/content.ts";
import { platformPlayDay } from "../../lib/content/game-date.ts";
import { getProperty } from "./properties.ts";

const nintendoPlatforms: ReadonlyMap<string, string> = new Map([
  ["Nintendo Switch", "Switch"], ["Nintendo Switch 2", "Switch 2"], ["Nintendo 3DS", "3DS"], ["Wii U", "Wii U"],
]);

function platformLabel(provider: string, platform: string): string | null {
  if (provider === "Steam" && platform === "PC") return "Steam";
  if (provider === "PSN" && (platform === "PS4" || platform === "PS5")) return "PlayStation";
  return provider === "Nintendo" ? nintendoPlatforms.get(platform) ?? null : null;
}

/** Accept only a bounded formula result from the existing private relation. Discard its timestamps after qualification. */
export function readLastPlayedPlatforms(page: PageObjectResponse, field: string, lastPlayed: DateRange | null, zone: string): string[] | null {
  const property = getProperty(page, field);
  const value = property?.type === "formula" && property.formula.type === "string" ? property.formula.string : null;
  const expectedDay = platformPlayDay(lastPlayed, zone)?.start;
  if (!value || !expectedDay || value.length > 2_000) return null;

  const lines = value.split("\n");
  if (lines.length >= 25) return null;
  const observations: { timestamp: number; day: string; label: string | null }[] = [];
  for (const line of lines) {
    const match = /^(\d{1,15})\|([^|\r\n]{0,24})\|([^|\r\n]{0,32})$/u.exec(line);
    if (!match) return null;
    const timestamp = Number(match[1]);
    const date = new Date(timestamp).toISOString();
    const day = platformPlayDay({ start: date, end: null, precision: "datetime" }, zone)?.start;
    if (!day) return null;
    observations.push({ timestamp, day, label: platformLabel(match[2], match[3]) });
  }

  const latest = observations.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
  if (latest.day !== expectedDay || (lastPlayed?.precision === "datetime" && latest.timestamp !== Date.parse(lastPlayed.start))) return null;
  const labels = new Set<string>();
  for (const { day, label } of observations) {
    if (day !== expectedDay) continue;
    if (!label) return null;
    labels.add(label);
  }
  return [...labels].sort();
}
