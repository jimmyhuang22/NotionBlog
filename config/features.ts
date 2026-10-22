import type { ContentKind } from "../contracts/content.ts";

export const CONTENT_KINDS = [
  "post", "status", "album", "book", "movie", "game", "course", "study-note", "project", "page",
] as const satisfies readonly ContentKind[];

export type ContentFeatures = Readonly<Record<ContentKind, boolean>>;

/** Only the first release's sections are public. Enable other DTOs deliberately. */
export const defaultContentFeatures: ContentFeatures = Object.freeze({
  post: false,
  status: true,
  album: false,
  book: false,
  movie: false,
  game: false,
  course: true,
  "study-note": true,
  project: false,
  page: false,
});

export function isContentKind(value: string): value is ContentKind {
  return CONTENT_KINDS.some((kind) => kind === value);
}

export function isEnabledContentKind(
  value: string,
  features: ContentFeatures = contentFeatures,
): value is ContentKind {
  return isContentKind(value) && features[value];
}

/** Runtime switches are public booleans; source identities remain in server-only config. */
export function parseContentFeatures(input: string | undefined): ContentFeatures {
  if (!input) return defaultContentFeatures;
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error("Invalid content feature configuration."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([k,v]) => !isContentKind(k) || typeof v !== "boolean")) throw new Error("Invalid content feature configuration.");
  return Object.freeze({ ...defaultContentFeatures, ...value });
}
export const contentFeatures = parseContentFeatures(process.env.CONTENT_FEATURES_JSON);
