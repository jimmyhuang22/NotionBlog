"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { coverFailureAction } from "../lib/content/cover-failure.ts";

/** A transparent pixel. An image with a size and no address (or a failed one) draws the browser's broken-picture
 * frame, so the wait before the retry shows this instead; its load is not the picture's. */
export const RETRY_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Keep the same image node (and its fade listeners) while retrying the same URL.
 * Callers key their picture by original source to cancel retries on replacement. */
export function useImageFailure(preview: string, original: string, ref: RefObject<HTMLImageElement | null>) {
  const [useOriginal, setOriginal] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const src = useOriginal ? original : preview;
  const lost = useCallback(() => {
    if (retrying || failed) return;
    const action = coverFailureAction(src, original, attempt);
    if (action === "retry") setRetrying(true);
    else if (action === "failed") setFailed(true);
    else setOriginal(true);
  }, [src, original, attempt, retrying, failed]);
  useEffect(() => {
    if (!retrying) return;
    const timer = setTimeout(() => { setAttempt(value => value + 1); setRetrying(false); }, 600);
    return () => clearTimeout(timer);
  }, [retrying]);
  useEffect(() => {
    const img = ref.current;
    if (retrying || failed || !img?.complete || img.naturalWidth > 0) return;
    // Size-less SVGs also have zero naturalWidth. Decode distinguishes them from failures.
    let live = true;
    img.decode().catch(() => { if (live) lost(); });
    return () => { live = false; };
  }, [ref, src, retrying, failed, lost]);
  // While waiting to retry the image shows the transparent placeholder; callers ignore its load event.
  return { src: retrying ? RETRY_PLACEHOLDER : src, original: useOriginal, failed, retrying, lost };
}
