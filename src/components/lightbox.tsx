"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { UNZOOMED, clampPan, zoomAbout, type Zoom } from "../lib/zoom.ts";
import { nearestShown } from "../lib/photo-order.ts";
import { closeOnBackdrop, useModal } from "./use-dismiss";

export interface Photo {
  key: string; src: string; alt: string; caption: string;
  /** The smaller version the page itself shows, when it differs from src; the viewer starts from it. */
  preview?: string;
  /** A 1600-wide version, when one may exist: the viewer sharpens to it and fetches the original only on zooming in past it. */
  large?: string;
  /** The original's size, when known: the viewer gives the photo its final place before the original has arrived. */
  width?: number | null; height?: number | null;
  /**
   * Self-hosted display-only delivery: src is the largest version there is, at most this wide (smaller pictures are
   * never enlarged). The viewer sharpens to src and stops there; the bar speaks of a sharper picture, not the original.
   */
  maxWidth?: number;
}
interface LightboxApi { register(photo: Photo): () => void; open(key: string): void }

const LightboxContext = createContext<LightboxApi | null>(null);
export const useLightbox = () => useContext(LightboxContext);

/** A little longer than the fade in prose.css, so the content is removed only after it is invisible. */
const CLOSE_MS = 240;

/**
 * Wraps one document. Every image inside can open in a full-screen viewer and step through
 * the document's other images. A native modal <dialog> supplies the focus trap, Escape to
 * close, and focus returning to the image that was opened. A photo can be enlarged by pinching,
 * a double tap or double click, a trackpad pinch, or the + and - keys, and dragged while enlarged.
 *
 * An original can take seconds to arrive. Where the page showed a smaller preview, the viewer opens
 * on that preview at the photo's final size and swaps in the original once it is ready; the bar says
 * so meanwhile. A second element with the preview's address reuses the picture already on the page.
 * Where a 1600-wide version may exist, the viewer swaps that in instead and leaves the original until
 * the photo is enlarged beyond what the 1600 can show; a missing 1600 is served as the original itself.
 * Until the stage has any picture at all (no preview yet, or a "preview" that is really the original
 * on its way) a spinner stands in the middle of it, so a slow photo never looks like an empty screen.
 * With display-only delivery (`maxWidth`) there is no original: src is the largest display version, so the
 * viewer goes from the preview to src and no further, and judges sharpness by that version's width.
 */
export function LightboxProvider({ className, children }: { className?: string; children: ReactNode }) {
  // The page's photos. Rendering reads the state, so a photo that leaves the page leaves the viewer too;
  // the same registry is kept in a ref for `open`, which looks it up at the moment of the press.
  const registry = useRef(new Map<string, Photo>());
  const [photos, setPhotos] = useState<ReadonlyMap<string, Photo>>(() => new Map());
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // The photos in reading order when the viewer opened, and the one on show (by key, not position, so it stays put when another one goes).
  const [view, setView] = useState<{ order: string[]; key: string } | null>(null);
  // Closing fades the dialog out; the picture stays in place until that has finished.
  const clearing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const api = useMemo<LightboxApi>(() => ({
    register(photo) {
      registry.current.set(photo.key, photo);
      setPhotos(new Map(registry.current));
      return () => {
        registry.current.delete(photo.key);
        setPhotos(new Map(registry.current));
      };
    },
    open(key) {
      // Reading order comes from the page itself, so columns and nested blocks stay in sequence.
      const order = [...(root.current?.querySelectorAll<HTMLElement>("[data-photo]") ?? [])]
        .map(element => element.dataset.photo ?? "").filter(candidate => registry.current.has(candidate));
      if (!order.includes(key)) return;
      clearTimeout(clearing.current);
      setView({ order, key });
    },
  }), []);

  useModal(dialog, view !== null);

  // Only photos still on the page can be shown. One that left while on show (a picture that failed to load
  // gives up its place) hands over to the next one still there, else the one before; with none left the viewer closes.
  const live = view ? view.order.filter(key => photos.has(key)) : [];
  const shownKey = view ? nearestShown(view.order, view.key, key => photos.has(key)) : undefined;
  const photo = shownKey ? photos.get(shownKey) : undefined;
  const gone = view !== null && !photo;
  useEffect(() => { if (gone) dialog.current?.close(); }, [gone]);
  const many = live.length > 1;
  const step = (delta: number) => {
    if (!view || !shownKey) return;
    const at = live.indexOf(shownKey);
    setView({ ...view, key: live[(at + delta + live.length) % live.length]! });
  };

  // How far the photo on show has got: its 1600 version and its original are each loaded or lost; "whole"
  // means what is on screen already is the full picture. Nothing yet means the viewer is still waiting.
  type Reached = { key: string; large?: "loaded" | "lost"; original?: "loaded" | "lost"; whole?: "preview" | "large" };
  const [progress, setProgress] = useState<Reached | null>(null);
  const reach = (key: string, change: Omit<Reached, "key">) => setProgress(current => ({ ...(current?.key === key ? current : {}), key, ...change }));
  // The photo whose original was asked for by enlarging it beyond its 1600 version.
  const [wanted, setWanted] = useState<string | null>(null);
  // The width that counts as the whole picture: the largest display version's where that is all there is, else the original's.
  const photoKey = photo?.key, photoSrc = photo?.src, photoPreview = photo?.preview, photoWidth = photo?.maxWidth ?? photo?.width;
  const displayOnly = photo?.maxWidth !== undefined;
  const photoLarge = photo?.preview ? photo.large : undefined;
  const reached = progress && progress.key === photoKey ? progress : null;
  const wantsOriginal = Boolean(photoKey) && (!photoLarge || reached?.large === "lost" || wanted === photoKey);
  useEffect(() => {
    if (!photoKey || !photoSrc || !photoPreview) return;
    // Where no preview exists the page shows the original under the preview's address; fetching it again would only repeat the download.
    const shown = new Image();
    shown.src = photoPreview;
    if (shown.complete && photoWidth && shown.naturalWidth >= photoWidth) { reach(photoKey, { whole: "preview" }); return; }
    if (!photoLarge) return;
    let current = true;
    const large = new Image();
    // Decoded before the swap, so the photo does not blink as it sharpens.
    large.onload = () => { void large.decode().catch(() => {}).then(() => {
      if (current) reach(photoKey, photoWidth && large.naturalWidth >= photoWidth ? { large: "loaded", whole: "large" } : { large: "loaded" });
    }); };
    large.onerror = () => { if (current) reach(photoKey, { large: "lost" }); };
    large.src = photoLarge;
    // Stepping on stops waiting for this one.
    return () => { current = false; large.onload = large.onerror = null; large.src = ""; };
  }, [photoKey, photoSrc, photoPreview, photoLarge, photoWidth]);
  const whole = Boolean(reached?.whole);
  useEffect(() => {
    if (!photoKey || !photoSrc || !photoPreview || !wantsOriginal || whole) return;
    if (!photoLarge) {
      const shown = new Image();
      shown.src = photoPreview;
      if (shown.complete && photoWidth && shown.naturalWidth >= photoWidth) return;
    }
    let current = true;
    const original = new Image();
    original.onload = () => { void original.decode().catch(() => {}).then(() => { if (current) reach(photoKey, { original: "loaded" }); }); };
    original.onerror = () => { if (current) reach(photoKey, { original: "lost" }); };
    original.src = photoSrc;
    return () => { current = false; original.onload = original.onerror = null; original.src = ""; };
  }, [photoKey, photoSrc, photoPreview, photoLarge, photoWidth, wantsOriginal, whole]);
  const onScreen = !photo ? undefined
    : reached?.original === "loaded" || !photo.preview ? photo.src
    : reached?.large === "loaded" && photoLarge ? photoLarge
    : photo.preview;
  const sharp = whole || reached?.original === "loaded" || (Boolean(photoLarge) && reached?.large === "loaded");
  const waiting = Boolean(photo?.preview) && !sharp && !reached?.original;
  // Enlarging the 1600 version beyond its own pixels asks for the original; read through a ref by gesture handlers bound earlier.
  const onLarge = useRef<string | null>(null);
  onLarge.current = photoKey && onScreen === photoLarge && !whole && wanted !== photoKey ? photoKey : null;
  // Display-only has no original to speak of: src is the sharper picture, and failing to get it is said that way.
  const status = waiting ? (displayOnly || (photoLarge && reached?.large !== "lost") ? "正在加载清晰图…" : "正在加载原图…")
    : wantsOriginal && photoLarge && reached?.large === "loaded" && !whole && !reached?.original ? "正在加载原图…"
    : reached?.original === "lost" ? (displayOnly ? (photo?.preview ? "清晰图没有加载出来，这是预览图" : "图片没有加载出来")
      : reached.large === "loaded" ? "原图没有加载出来，这是较清晰的版本" : photo?.preview ? "原图没有加载出来，这是预览图" : "图片没有加载出来")
    : "";
  const sized = Boolean(photo?.width && photo.height);
  // Which photo has something on screen yet, whatever version it is.
  const [painted, setPainted] = useState<string | null>(null);

  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  // The transform is written straight to the element so a gesture does not re-render per frame.
  const zoom = useRef<Zoom>(UNZOOMED);
  const [zoomed, setZoomed] = useState(false);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; swipe: boolean; multi: boolean } | null>(null);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const lastPointer = useRef("mouse");

  function applyZoom(next: Zoom, eased = false) {
    const img = image.current, box = stage.current;
    if (!img || !box) return;
    const bounded = clampPan(next, { width: img.offsetWidth, height: img.offsetHeight }, { width: box.clientWidth, height: box.clientHeight });
    zoom.current = bounded.scale === 1 ? UNZOOMED : bounded;
    img.classList.toggle("is-eased", eased);
    img.style.transform = zoom.current === UNZOOMED ? "" : `translate(${bounded.x}px, ${bounded.y}px) scale(${bounded.scale})`;
    setZoomed(zoom.current !== UNZOOMED);
    // A tenth of slack, so the original is fetched only when the 1600 would visibly soften.
    const key = onLarge.current;
    if (key && bounded.scale > 1 && img.offsetWidth * bounded.scale * (window.devicePixelRatio || 1) > img.naturalWidth * 1.1) setWanted(key);
  }
  /** A viewport point measured from where the photo's centre sits when it is not moved. */
  function fromCentre(x: number, y: number) {
    const rect = image.current?.getBoundingClientRect();
    return rect ? { x: x - (rect.left + rect.width / 2 - zoom.current.x), y: y - (rect.top + rect.height / 2 - zoom.current.y) } : { x: 0, y: 0 };
  }
  function toggleZoom(x: number, y: number) {
    const point = fromCentre(x, y);
    applyZoom(zoom.current === UNZOOMED ? zoomAbout(UNZOOMED, 2.5, point.x, point.y) : UNZOOMED, true);
  }
  const zoomBy = (factor: number) => applyZoom(zoomAbout(zoom.current, zoom.current.scale * factor, 0, 0), true);

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    lastPointer.current = event.pointerType;
    if ((event.target as Element).closest("button")) return;
    // A mouse only drags an enlarged photo; its double click is handled separately.
    if (event.pointerType === "mouse" && zoom.current === UNZOOMED) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.current.size === 1) gesture.current = { x: event.clientX, y: event.clientY, swipe: event.pointerType !== "mouse" && zoom.current === UNZOOMED, multi: false };
    else if (gesture.current) gesture.current.multi = true;
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const previous = touches.current.get(event.pointerId);
    if (!previous) return;
    const point = { x: event.clientX, y: event.clientY };
    touches.current.set(event.pointerId, point);
    const other = [...touches.current].find(([id]) => id !== event.pointerId)?.[1];
    if (other) {
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const middle = fromCentre((point.x + other.x) / 2, (point.y + other.y) / 2);
      const scaled = before > 0 ? zoomAbout(zoom.current, zoom.current.scale * Math.hypot(point.x - other.x, point.y - other.y) / before, middle.x, middle.y) : zoom.current;
      // The midpoint between two fingers travels half as far as the one that moved.
      applyZoom({ scale: scaled.scale, x: scaled.x + (point.x - previous.x) / 2, y: scaled.y + (point.y - previous.y) / 2 });
    } else if (zoom.current !== UNZOOMED) {
      applyZoom({ scale: zoom.current.scale, x: zoom.current.x + point.x - previous.x, y: zoom.current.y + point.y - previous.y });
    }
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!touches.current.delete(event.pointerId) || touches.current.size > 0) return;
    const start = gesture.current;
    gesture.current = null;
    if (!start || start.multi) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    // Touch: a mostly horizontal drag of a thumb's width moves to the neighbouring photo.
    if (start.swipe && many && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) { lastTap.current = null; step(dx < 0 ? 1 : -1); return; }
    if (event.pointerType === "mouse" || Math.hypot(dx, dy) > 10) return;
    const tap = lastTap.current;
    if (tap && event.timeStamp - tap.time < 320 && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 32) { lastTap.current = null; toggleZoom(event.clientX, event.clientY); }
    else lastTap.current = { time: event.timeStamp, x: event.clientX, y: event.clientY };
  }

  // Each photo starts at its fitted size.
  useEffect(() => {
    // A picture the browser already holds can be complete before its load event is listened for.
    const img = image.current;
    if (photoKey && img?.complete && img.naturalWidth > 0) setPainted(photoKey);
    zoom.current = UNZOOMED;
    touches.current.clear();
    gesture.current = null;
    lastTap.current = null;
    setZoomed(false);
  }, [photoKey]);

  // A trackpad pinch arrives as a wheel event with the control modifier; it must be cancellable to stop the page zooming.
  const showing = Boolean(photo);
  useEffect(() => {
    const box = stage.current;
    if (!showing || !box) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const point = fromCentre(event.clientX, event.clientY);
      applyZoom(zoomAbout(zoom.current, zoom.current.scale * Math.exp(-event.deltaY * 0.01), point.x, point.y));
    };
    box.addEventListener("wheel", wheel, { passive: false });
    return () => box.removeEventListener("wheel", wheel);
  }, [showing]);

  return (
    <LightboxContext.Provider value={api}>
      <div ref={root} className={className}>{children}</div>
      <dialog
        ref={dialog}
        className="lightbox"
        aria-label="查看大图"
        onClose={() => { clearing.current = setTimeout(() => setView(null), CLOSE_MS); }}
        onClick={closeOnBackdrop}
        onKeyDown={event => {
          if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(1.5); }
          if (event.key === "-") { event.preventDefault(); zoomBy(1 / 1.5); }
          if (event.key === "0") { event.preventDefault(); applyZoom(UNZOOMED, true); }
          if (!many) return;
          if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
          if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
        }}
      >
        {view && photo ? (
          <div className="lightbox__frame">
            <div className="lightbox__bar">
              <span className="lightbox__info">
                <span className="lightbox__count" aria-live="polite">{many ? `${live.indexOf(photo.key) + 1} / ${live.length}` : ""}</span>
                <span className="lightbox__state" role="status">{status}</span>
              </span>
              <button type="button" className="lightbox__button lightbox__close" onClick={() => dialog.current?.close()} aria-label="关闭">
                {/* Two strokes of the pen, like the arrows (X-07, 2026-10-20). */}
                <svg aria-hidden="true" width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5.2 5.6c3.6 3.4 7.6 7.4 11.3 11.1M16.6 5.1c-3.5 3.9-7.3 7.8-11.2 11.6" /></svg>
              </button>
            </div>
            <div
              ref={stage}
              className={zoomed ? "lightbox__stage lightbox__stage--zoomed" : "lightbox__stage"}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={event => { touches.current.delete(event.pointerId); gesture.current = null; }}
              onDoubleClick={event => { if (lastPointer.current === "mouse" && !(event.target as Element).closest("button")) toggleZoom(event.clientX, event.clientY); }}
            >
              {many ? (
                <button type="button" className="lightbox__button lightbox__nav" onClick={() => step(-1)} aria-label="上一张">
                  {/* Arrows drawn in one stroke of the pen, paper on the dark stage (X-04). */}
                  <svg aria-hidden="true" width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M24 15.5C18 15 11 15.6 6 15.2M11.5 9.5C9.5 11.6 7.6 13.4 5.8 15.3c2 1.6 3.9 3.4 5.6 5.4" /></svg>
                </button>
              ) : null}
              {/* Same re-authorised media path as the page; no optimiser or long-lived cache in between. */}
              <img
                ref={image} key={photo.key} src={onScreen} alt={photo.alt}
                data-sized={sized ? "" : undefined} data-painted={painted === photo.key ? "" : undefined} style={sized ? { "--w": photo.width, "--h": photo.height } as CSSProperties : undefined}
                onLoad={event => { setPainted(photo.key); if (!photo.preview && event.currentTarget.getAttribute("src") === photo.src) reach(photo.key, { original: "loaded" }); }}
                onError={() => { if (!photo.preview) reach(photo.key, { original: "lost" }); }}
              />
              {/* Said in words in the bar for assistive technology; this is for the eye. */}
              {painted !== photo.key && reached?.original !== "lost" ? <span className="lightbox__wait" aria-hidden="true"><span className="lightbox__spinner" />正在加载</span> : null}
              {many ? (
                <button type="button" className="lightbox__button lightbox__nav" onClick={() => step(1)} aria-label="下一张">
                  <svg aria-hidden="true" width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15.2c6 .5 13-.1 18 .3M18.5 9.6c2 2 3.9 3.8 5.7 5.7-2 1.6-3.9 3.4-5.6 5.4" /></svg>
                </button>
              ) : null}
            </div>
            {photo.caption ? <p className="lightbox__caption">{photo.caption}</p> : null}
          </div>
        ) : null}
      </dialog>
    </LightboxContext.Provider>
  );
}
