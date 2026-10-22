import { createHash } from "node:crypto";
import type { StoredMedia } from "../../../contracts/sync.ts";
import { mediaIdentity, validateMedia } from "../database/validation.ts";

/** Private locator; never serialized into a public content DTO. */
export type NotionMediaLocator = { kind: "block"; id: string } | { kind: "property"; name: string } | { kind: "cover" };
export interface MediaSourceBinding {
  assetId: string;
  ownerPageId: string;
  sha256: string;
  locator: NotionMediaLocator;
  delivery: "notion" | "storage";
  sourceFingerprint: string;
}
export interface MediaSourceProjection { media: StoredMedia; binding: MediaSourceBinding }
export type MediaSourceVersion = "v1" | "v2";

/** Hosted signature/expiry query parameters change without changing the source file. */
export function sourceFingerprint(value: string, hosted: boolean): string {
  const url = new URL(value);
  return createHash("sha256").update(JSON.stringify(hosted ? ["file", url.origin, url.pathname] : ["external", url.href])).digest("hex");
}

export function locatorIdentity(locator: NotionMediaLocator, version: MediaSourceVersion = "v1"): string {
  if (version === "v2") return locator.kind === "block" ? locator.id : locator.kind === "property" ? locator.name : "cover";
  return locator.kind === "block" ? `block:${locator.id}` : locator.kind === "property" ? `property:${locator.name}` : "cover";
}

export function validateMediaSource(binding: MediaSourceBinding, media: StoredMedia, version: MediaSourceVersion = "v1"): void {
  validateMedia(media);
  const locator = binding?.locator;
  const exactKeys = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (!exactKeys(binding, ["assetId", "ownerPageId", "sha256", "locator", "delivery", "sourceFingerprint"]) ||
      !locator || !["block", "property", "cover"].includes(locator.kind) ||
      !exactKeys(locator, locator.kind === "block" ? ["kind", "id"] : locator.kind === "property" ? ["kind", "name"] : ["kind"]) ||
      typeof binding.sourceFingerprint !== "string" ||
      (locator.kind === "block" && !/^[a-f0-9]{32}$/.test(locator.id)) ||
      (locator.kind === "property" && (typeof locator.name !== "string" || !locator.name || locator.name.length > 256)) ||
      !["notion", "storage"].includes(binding.delivery) || !/^[a-f0-9]{64}$/.test(binding.sourceFingerprint) ||
      binding.assetId !== media.assetId || binding.ownerPageId !== media.ownerPageId || binding.sha256 !== media.sha256 ||
      mediaIdentity(binding.ownerPageId, locatorIdentity(locator, version), binding.sha256) !== binding.assetId) {
    throw new Error("Invalid media source binding.");
  }
}
