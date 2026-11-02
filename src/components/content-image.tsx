"use client";

import { useEffect, useId } from "react";
import type { ImageAsset } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";
import { useLightbox } from "./lightbox";
import { useImageFailure } from "./use-image-failure";
import { useFadeIn } from "./use-fade-in";

type Props = { image: ImageAsset; caption?: string; previewWidth?: 400 | 800 };

/** Plain img on purpose: media paths are re-authorised per request and must not pass through an optimiser cache. */
export function ContentImage(props: Props) {
  // A new address is a new picture (as in cover-image.tsx): a failure or a fallback to the original stays with the old one.
  return <ContentImagePicture key={props.image.src} {...props} />;
}

function ContentImagePicture({ image, caption = "", previewWidth }: Props) {
  const lightbox = useLightbox();
  const key = useId();
  const fade = useFadeIn();
  const { src, alt, width, height } = image;
  // Self-hosted display-only: src is already the largest version there is (at most 1600 wide); nothing beyond it exists.
  const maxWidth = image.delivery?.mode === "display-only" ? image.delivery.maxWidth : undefined;
  const initialPreview = previewWidth === undefined ? src : imagePreviewSrc(image, previewWidth);
  const { src: displaySrc, original, failed, lost } = useImageFailure(initialPreview, src, fade);
  const preview = original || initialPreview === src ? undefined : initialPreview;
  // The 1600 version is only worth it between a smaller preview on the page and the original; display-only has no original past src.
  const larger = preview && maxWidth === undefined ? imagePreviewSrc(image, 1600) : src;
  const large = larger === src || larger === preview ? undefined : larger;
  useEffect(() => {
    if (!lightbox || failed) return;
    // The viewer opens on what is already on the page and fetches the sharper version from there.
    return lightbox.register({ key, src, alt, caption, preview, large, width, height, ...(maxWidth === undefined ? {} : { maxWidth }) });
  }, [lightbox, failed, key, src, alt, caption, preview, large, width, height, maxWidth]);

  if (failed) return <div className="figure__failed" role="img" aria-label={alt || "图片"}>图片暂时无法显示</div>;
  const img = <img ref={fade} src={displaySrc} alt={alt} width={width ?? undefined} height={height ?? undefined} loading="lazy" decoding="async" onError={lost} />;
  if (!lightbox) return img;
  return (
    <button type="button" className="figure__zoom" data-photo={key} onClick={() => lightbox.open(key)} aria-label={`查看大图：${alt || caption || "图片"}`}>
      {img}
    </button>
  );
}
