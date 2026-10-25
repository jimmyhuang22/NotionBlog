import type { PageObjectResponse, RichTextItemResponse } from "@notionhq/client";
import type { DateRange, Rating } from "../../../contracts/content.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { PUBLIC_USER_MENTION_TEXT, sanitizePublicText } from "./public-text.ts";

export type NotionPageProperty = PageObjectResponse["properties"][string];

function decodedId(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Lookup is explicit by configured name or property ID, never by a guessed type. */
export function getProperty(page: PageObjectResponse, field?: string): NotionPageProperty | null {
  if (!field) return null;
  return page.properties[field] ?? Object.values(page.properties).find((property) =>
    decodedId(property.id) === decodedId(field)) ?? null;
}

export function plainText(text: readonly RichTextItemResponse[]): string {
  // Metadata has no async resolver; mention labels never grant publication of identities.
  return sanitizePublicText(text.map(run => {
    if (run.type !== "mention") return run.plain_text;
    if (run.mention.type === "user") return PUBLIC_USER_MENTION_TEXT;
    return run.mention.type === "page" || run.mention.type === "database" ? "Notion page" : run.plain_text;
  }).join(""));
}

export function getTitle(page: PageObjectResponse, field: string): string {
  const property = getProperty(page, field);
  return property?.type === "title" ? plainText(property.title) : "";
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Datetimes must carry a timezone; unzoned input is not silently interpreted locally. */
export function normalizeDateTime(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value) || !validDate(value.slice(0, 10))) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeDateRange(start: string, end: string | null = null): DateRange | null {
  const precision = validDate(start) ? "date" : "datetime";
  const normalizedStart = precision === "date" ? start : normalizeDateTime(start);
  if (!normalizedStart) return null;
  const normalizedEnd = end === null ? null : precision === "date" ? validDate(end) ? end : null : normalizeDateTime(end);
  if (end !== null && normalizedEnd === null) return null;
  return { start: normalizedStart, end: normalizedEnd, precision };
}

/** created_time is used only if the source explicitly maps a created_time property. */
export function getDate(page: PageObjectResponse, field?: string): DateRange | null {
  const property = getProperty(page, field);
  if (property?.type === "date" && property.date) return normalizeDateRange(property.date.start, property.date.end);
  if (property?.type === "created_time") return normalizeDateRange(property.created_time);
  return null;
}

/** Only a completed latest-date rollup is an observed platform play date. */
export function getLastPlayedDate(page: PageObjectResponse, field?: string): DateRange | null {
  return getPlatformPlayDate(page, field, "latest_date");
}

/** First play must be an actual earliest-date observation, never inferred from last play. */
export function getFirstPlayedDate(page: PageObjectResponse, field?: string): DateRange | null {
  return getPlatformPlayDate(page, field, "earliest_date");
}

function getPlatformPlayDate(page: PageObjectResponse, field: string | undefined, functionName: "latest_date" | "earliest_date"): DateRange | null {
  const property = getProperty(page, field);
  if (!property || property.type === "date") return getDate(page, field);
  if (property.type !== "rollup" || property.rollup.function !== functionName || property.rollup.type !== "date") {
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "The platform play date is unavailable.");
  }
  const value = property.rollup.date;
  return value ? normalizeDateRange(value.start, value.end) : null;
}

export function getTags(page: PageObjectResponse, field?: string): string[] {
  const property = getProperty(page, field);
  return property?.type === "multi_select" ? [...new Set(property.multi_select.map((option) => sanitizePublicText(option.name)))] : [];
}

/** Scalar labels and explicitly configured semester multi-selects retain source text. */
export function getSelect(page: PageObjectResponse, field?: string): string | null {
  const property = getProperty(page, field);
  if (!property) return null;
  switch (property.type) {
    case "select": return property.select ? sanitizePublicText(property.select.name) : null;
    case "status": return property.status ? sanitizePublicText(property.status.name) : null;
    case "rich_text": return plainText(property.rich_text) || null;
    case "title": return plainText(property.title) || null;
    case "multi_select": return property.multi_select.map((option) => sanitizePublicText(option.name)).join(", ") || null;
    default: return null;
  }
}

/** Only numeric literals, explicit fractions and pure star counts have known values. */
export function getRating(page: PageObjectResponse, field?: string): Rating | null {
  const property = getProperty(page, field);
  if (!property) return null;
  if (property.type === "number") {
    return property.number !== null && Number.isFinite(property.number)
      ? { value: property.number, scale: null, label: String(property.number) } : null;
  }
  const label = getSelect(page, field);
  if (label === null) return null;
  const numeric = label.trim();
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(numeric)) {
    const value = Number(numeric);
    return { value: Number.isFinite(value) ? value : null, scale: null, label };
  }
  const fraction = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/u.exec(numeric);
  if (fraction) {
    const value = Number(fraction[1]);
    const scale = Number(fraction[2]);
    if (Number.isFinite(value) && Number.isFinite(scale) && scale > 0 && value <= scale) return { value, scale, label };
  }
  const starText = numeric.replace(/\uFE0F/gu, "");
  if (/^[★⭐☆]+$/u.test(starText)) {
    const stars = [...starText];
    return { value: stars.filter((star) => star !== "☆").length, scale: numeric.includes("☆") ? stars.length : null, label };
  }
  return { value: null, scale: null, label };
}

/** Explicit numeric/formula/rollup mappings; unknown or negative quantities stay null. */
export function getNumber(page: PageObjectResponse, field?: string): number | null {
  const property = getProperty(page, field);
  const value = property?.type === "number" ? property.number
    : property?.type === "formula" && property.formula.type === "number" ? property.formula.number
    : property?.type === "rollup" && property.rollup.type === "number" ? property.rollup.number : null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function getValues(page: PageObjectResponse, field?: string): string[] {
  const property = getProperty(page, field);
  if (property?.type === "multi_select") return property.multi_select.map(x => sanitizePublicText(x.name));
  const value = getSelect(page, field);
  return value ? [value] : [];
}
export function getPublicUrl(page: PageObjectResponse, field?: string): string | null {
  const property = getProperty(page, field), value = property?.type === "url" ? property.url : null;
  if (!value) return null;
  try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && sanitizePublicText(value) === value ? u.href : null; } catch { return null; }
}
