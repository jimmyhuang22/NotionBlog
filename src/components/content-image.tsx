"use client";

import { useEffect, useId, useState } from "react";
import type { ImageAsset } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { useLightbox } from "./lightbox";
import { useFadeIn } from "./use-fade-in";

/** Plain img on purpose: media paths are re-authorised per request and must not pass through an optimiser cache. */
export function ContentImage({ image, caption = "", previewWidth }: { image: ImageAsset; caption?: string; previewWidth?: 400 | 800 }) {
  const [failed, setFailed] = useState(false);
  // A preview that cannot be read gives way to the original once; only the original failing too is a failure.
  const [original, setOriginal] = useState(false);
  const lightbox = useLightbox();
  const key = useId();
  const fade = useFadeIn();
  const { src, alt, width, height } = image;
  const displaySrc = previewWidth === undefined || original ? src : imagePreviewSrc(image, previewWidth);
  // The 1600 version is only worth it between a smaller preview on the page and the original.
  const preview = displaySrc === src ? undefined : displaySrc;
  const larger = preview ? imagePreviewSrc(image, 1600) : src;
  const large = larger === src || larger === preview ? undefined : larger;
  useEffect(() => {
    if (!lightbox || failed) return;
    // The viewer opens on what is already on the page and fetches the original from there.
    return lightbox.register({ key, src, alt, caption, preview, large, width, height });
  }, [lightbox, failed, key, src, alt, caption, preview, large, width, height]);

  // A picture can fail before the page is interactive, when no error event reaches here (as in cover-image.tsx):
  // without this, the browser's broken-image mark would stay, with no original tried and no notice shown.
  useEffect(() => {
    const img = fade.current;
    if (!img?.complete || img.naturalWidth > 0) return;
    // A drawing without a size of its own also reads as zero wide; decoding tells it apart from a broken file.
    let live = true;
    img.decode().catch(() => {
      if (!live) return;
      if (img.getAttribute("src") === src) setFailed(true);
      else setOriginal(true);
    });
    return () => { live = false; };
  }, [fade, src]);

  if (failed) return <div className="figure__failed" role="img" aria-label={alt || "图片"}>图片暂时无法显示</div>;
  const img = <img ref={fade} src={displaySrc} alt={alt} width={width ?? undefined} height={height ?? undefined} loading="lazy" decoding="async" onError={() => (displaySrc === src ? setFailed(true) : setOriginal(true))} />;
  if (!lightbox) return img;
  return (
    <button type="button" className="figure__zoom" data-photo={key} onClick={() => lightbox.open(key)} aria-label={`查看大图：${alt || caption || "图片"}`}>
      {img}
    </button>
  );
}
