"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ImageAsset } from "../../contracts/content.ts";
import { imagePreviewSrc } from "../lib/content/image-preview.ts";

interface Props {
  image: ImageAsset;
  /** The picture's own class; the failed block takes the same name with `--failed` for its spacing. */
  className: string;
  previewWidth: 400 | 800;
  /** The failed block's name for assistive technology when the picture has no alt text. */
  label: string;
  /** Alt text for a picture whose source gives none. */
  alt?: string;
  /** For covers further down a page or in a list. */
  lazy?: boolean;
  /** Pass the source's dimensions on, so the place is held at the picture's shape. */
  sized?: boolean;
  /** What stands in when the picture cannot be read: the quiet block when left out, nothing when null. */
  fallback?: ReactNode;
  /**
   * A larger preview for a wide picture on a sharp screen, offered beside `previewWidth`; the browser
   * picks by `sizes`, the width the picture is shown at. Only where the larger tier is registered.
   */
  larger?: { width: 1600; sizes: string };
}

/**
 * A cover: of a page, an entry or a card. Plain img on purpose: media paths are re-authorised per
 * request and must not pass through an optimiser cache. A cover that does not arrive never shows the
 * browser's broken-picture mark: it says so in the site's own quiet way, or gives way to what the
 * caller shows for "no cover". A preview that cannot be read gives way to the original first. Until it
 * arrives its place is a soft block.
 */
export function CoverImage(props: Props) {
  // A replacement must not inherit the old image's terminal error or original fallback.
  return <CoverImageContent key={props.image.src} {...props} />;
}
function CoverImageContent({ image, className, previewWidth, label, alt, lazy = false, sized = true, fallback, larger }: Props) {
  const ref = useRef<HTMLImageElement>(null);
  const [state, setState] = useState<"waiting" | "shown" | "failed">("waiting");
  const [original, setOriginal] = useState(false);
  const src = original ? image.src : imagePreviewSrc(image, previewWidth);
  const big = larger && !original ? imagePreviewSrc(image, larger.width) : null;
  // Both tiers must be real previews; falling back to the original drops the choice with them, or the browser could keep picking the failed one.
  const srcSet = big && big !== image.src && src !== image.src ? `${src} ${previewWidth}w, ${big} ${larger!.width}w` : undefined;
  const lost = () => (src === image.src ? setState("failed") : setOriginal(true));
  // A cover can be settled before the page is interactive, when no event reaches here.
  useEffect(() => {
    const img = ref.current;
    if (!img?.complete) return;
    if (img.naturalWidth > 0) setState("shown");
    else if (img.getAttribute("src") === image.src) setState("failed");
    else setOriginal(true);
  }, [image.src]);
  if (state === "failed") {
    return fallback === undefined
      ? <div className={`figure__failed ${className}--failed`} role="img" aria-label={image.alt || alt || label}>封面暂时无法显示</div>
      : fallback;
  }
  return (
    <img
      ref={ref} className={`${className} cover-image`} src={src} srcSet={srcSet} sizes={srcSet ? larger!.sizes : undefined} alt={image.alt || alt || ""}
      width={sized ? image.width ?? undefined : undefined} height={sized ? image.height ?? undefined : undefined}
      loading={lazy ? "lazy" : undefined} decoding={lazy ? "async" : undefined} data-shown={state === "shown" ? "" : undefined}
      onLoad={() => setState("shown")} onError={lost}
    />
  );
}
