export function thumbnailWindow(publication: { startedAt: string; published: boolean; readerVerified: boolean }, now?: number, maximumSeconds?: number): {
  status: 'deferred' | 'ready'; code: 'THUMBNAIL_DEFERRED' | null; deadlineUTC: string; seconds: number;
};
