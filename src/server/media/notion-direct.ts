import { ContentServiceError } from "../../../contracts/repository.ts";
import { checkContentReadBudget, contentReadBudgetIdentity, withContentReadBudget } from "../content-read-budget.ts";
import { verifyDirectPolicy } from "../notion/direct-policy.ts";
import { resolveSignedMediaSource } from "../notion/media.ts";
import type { NotionRepository } from "../notion/repository.ts";
import type { NotionReadClient } from "../notion/types.ts";
import { downloadDirectImage } from "./notion-direct-download.ts";
import type { DownloadedImage } from "../../../scripts/notion-sync/download.ts";

const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export function withDirectMediaBudget<T>(request: Request, read: () => Promise<T>): Promise<T> {
  checkContentReadBudget();
  const parent = contentReadBudgetIdentity();
  return withContentReadBudget(AbortSignal.any([request.signal, AbortSignal.timeout(8000), ...(parent ? [parent.signal] : [])]), read,
    { timeoutMs: parent ? Math.min(8000, parent.deadline - parent.now()) : 8000 });
}
export async function directNotionMediaResponse(id: string, repository: NotionRepository, client: NotionReadClient, secret: string,
  download: (url: string, signal: AbortSignal) => Promise<DownloadedImage> = downloadDirectImage): Promise<Response> {
  const missing = () => new Response(null, { status: 404, headers });
  checkContentReadBudget();
  const source = await resolveSignedMediaSource(id, repository, client, secret);
  if (!source) return missing();
  const budget = contentReadBudgetIdentity();
  if (!budget) throw new ContentServiceError("MISCONFIGURED", "A bounded image request is required.");
  const image = await download(source.url, budget.signal);
  checkContentReadBudget();await verifyDirectPolicy();
  const final = await resolveSignedMediaSource(id, repository, client, secret);
  if (!final || final.sourceFingerprint !== source.sourceFingerprint) return missing();
  checkContentReadBudget();
  return new Response(Buffer.from(image.bytes), { headers: { ...headers, "Content-Type": image.mime, "Content-Length": String(image.bytes.byteLength) } });
}
