"use client";

import { useEffect, useRef } from "react";

/**
 * Lets an image fade in once it has loaded. The image is only hidden after the page is interactive
 * and only when it has not arrived yet, so without scripts, or from cache, it is simply there.
 */
export function useFadeIn() {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = ref.current;
    if (!image || image.complete) return;
    image.classList.add("is-loading");
    const show = () => image.classList.remove("is-loading");
    image.addEventListener("load", show, { once: true });
    image.addEventListener("error", show, { once: true });
    return () => { image.removeEventListener("load", show); image.removeEventListener("error", show); show(); };
  }, []);
  return ref;
}
