"use client";

import { useEffect, useRef } from "react";
import { RETRY_PLACEHOLDER } from "./use-image-failure";

/**
 * Lets an image fade in once it has loaded. The image is only hidden after the page is interactive
 * and only when it has not arrived yet, so without scripts, or from cache, it is simply there.
 * Only the picture itself ends the wait: the retry placeholder's load does not, and a failure is
 * useImageFailure's (a retry, the original, or the failed block that replaces this image), so the
 * soft block stays through a retry instead of vanishing for its 600 ms.
 */
export function useFadeIn() {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = ref.current;
    if (!image || image.complete) return;
    image.classList.add("is-loading");
    const show = () => {
      if (image.getAttribute("src") === RETRY_PLACEHOLDER) return;
      image.classList.remove("is-loading");
      image.removeEventListener("load", show);
    };
    image.addEventListener("load", show);
    return () => { image.removeEventListener("load", show); image.classList.remove("is-loading"); };
  }, []);
  return ref;
}
