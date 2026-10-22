import type { WebsiteRecord } from "../../contracts/website-sync.ts";
import type { StoredMedia } from "../../contracts/sync.ts";
import { fixtureItems } from "../../fixtures/content.ts";
import { contentCacheBaselineDigest, type ContentCacheBaseline } from "../../scripts/website-incremental-sync/content-cache.ts";
import { studyFixture, studyId } from "./study-runtime.ts";

export function cacheFixture(withImage = false) {
  const f = studyFixture(), status = structuredClone(fixtureItems.status[0]);
  delete (status as unknown as Record<string, unknown>).images; delete (status as unknown as Record<string, unknown>).hasMoreBody;
  Object.assign(status, { id: studyId(20), slug: studyId(20), href: `/status#${studyId(20)}`, cover: null });
  const note = f.checkpoint.entries[1].record.detail.item;
  const ordinary: WebsiteRecord = { detail: { item: status, document: { blocks: [
    { id: "paragraph", type: "paragraph", text: [{ text: "See note", link: { kind: "internal", href: note.href } }] },
    { id: "child", type: "child-page", title: "Note", target: { href: note.href, title: note.title } },
  ], toc: [], completeness: "complete" } }, evidence: { sourceKey: "status", dataSourceId: studyId(11), databaseParentId: null, courseId: null, parentId: null, ordinal: 3 } };
  const other = structuredClone(ordinary); Object.assign(other.detail.item, { id: studyId(21), slug: studyId(21), href: `/status#${studyId(21)}` }); other.detail.document!.blocks = []; other.evidence.ordinal = 4;
  const media: StoredMedia[] = withImage ? [{ assetId: `a1.${"b".repeat(64)}`, ownerPageId: status.id, sha256: "c".repeat(64), objectKey: `sha256/${"c".repeat(64)}`, byteSize: 123, mime: "image/png", width: 40, height: 20 }] : [];
  if (media.length) status.cover = { id: media[0].assetId, src: `/media/v2/${media[0].assetId}`, alt: "Synthetic", width: 40, height: 20 };
  const baseline: ContentCacheBaseline = { state: f.state, records: [...f.checkpoint.entries.map(e => e.record), ordinary, other], media };
  return { ...f, ordinary, other, baseline, sourceKeys: ["courses", "notes", "status"] };
}
export function cacheProof(b: ContentCacheBaseline) { return { ...b.state, readerVerified: true as const, complete: true as const, records: b.records.length, media: b.media.length, contentDigest: contentCacheBaselineDigest(b) }; }
