"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { coverFailureAction } from "../lib/content/cover-failure.ts";

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
  return { src: retrying ? undefined : src, original: useOriginal, failed, lost };
}
