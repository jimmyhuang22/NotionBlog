import type { FeedSnapshot } from "../../../contracts/home-feed.ts";
import type { SocialWork } from "../../../contracts/social.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { MAX_SOCIAL_SNAPSHOT_BYTES } from "../../lib/content/social-limits.ts";

/** Request-local server capability; repositories return only the selected DTOs. */
export interface SocialCoverSnapshot<T extends SocialWork> extends FeedSnapshot<T> {
  hydrateCovers?: (selected: T[]) => Promise<T[]>;
}

/** Covers cannot change membership, order, sort keys, statistics or cursor inputs. */
export async function hydrateSelectedSocialCovers<T extends SocialWork>(snapshot: SocialCoverSnapshot<T>, selected: T[]): Promise<T[]> {
  if (!selected.length || snapshot.hydrateCovers === undefined) return selected;
  const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "Social covers are temporarily unavailable.");
  if (typeof snapshot.hydrateCovers !== "function") throw unavailable();
  const before = selected.map(work => JSON.stringify({ ...work, cover: null }));
  const items = await snapshot.hydrateCovers(selected);
  if (!Array.isArray(items) || items.length !== before.length || items.some((work, i) =>
    !work || JSON.stringify({ ...work, cover: null }) !== before[i]) ||
    Buffer.byteLength(JSON.stringify(items)) > MAX_SOCIAL_SNAPSHOT_BYTES) throw unavailable();
  return items;
}
