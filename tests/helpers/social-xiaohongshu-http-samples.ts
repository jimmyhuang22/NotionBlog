import { config } from "../../scripts/social-sync/model.ts";
export const httpTarget = (n = 2) => config({ version: 1, publications: [{ platform: "xiaohongshu", accountId: "000000000000000000000001",
  workId: `example-note-${n}`, url: `https://www.xiaohongshu.com/explore/${String(n).padStart(24, "0")}` }] })[0]!;
export const httpUrl = (n = 2) => httpTarget(n).url + "?source=webshare&xhsshare=pc_web&xsec_token=example_public_locator&xsec_source=pc_share";
export function httpState(n = 2) {
  const target = httpTarget(n);
  return { note: { currentNoteId: target.publicationId, noteDetailMap: { [target.publicationId]: { note: {
    noteId: target.publicationId, user: { userId: target.accountId }, type: "normal", title: "Example undefined } note",
    time: 1700000000000, lastUpdateTime: null, imageList: [],
    interactInfo: { likedCount: "1.2万", commentCount: "0", shareCount: "", collectedCount: "4" },
    desc: "Not retained", comments: [{ content: "Not retained" }],
  } } } } };
}
export const httpHtml = (n = 2) => `<html><script>window.__INITIAL_STATE__=${JSON.stringify(httpState(n))};</script></html>`;
