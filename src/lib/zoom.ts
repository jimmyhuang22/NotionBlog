/** A photo's magnification and its offset from the centred position, in CSS pixels. */
export interface Zoom { scale: number; x: number; y: number }
export interface Size { width: number; height: number }

export const UNZOOMED: Zoom = { scale: 1, x: 0, y: 0 };
export const MAX_SCALE = 4;

// Adding 0 turns a negative zero from an empty range into plain zero.
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)) + 0;

/**
 * Change the scale while the point under the fingers stays where it is. px and py are measured
 * from the photo's centred position. Scaling back to 1 always returns to the centre.
 */
export function zoomAbout(zoom: Zoom, scale: number, px: number, py: number): Zoom {
  const next = clamp(scale, 1, MAX_SCALE);
  if (next === 1) return UNZOOMED;
  const ratio = next / zoom.scale;
  return { scale: next, x: px - ratio * (px - zoom.x), y: py - ratio * (py - zoom.y) };
}

/** Keep the photo over the stage: it can move only as far as its enlarged size overhangs the stage. */
export function clampPan(zoom: Zoom, photo: Size, stage: Size): Zoom {
  const reachX = Math.max(0, (photo.width * zoom.scale - stage.width) / 2);
  const reachY = Math.max(0, (photo.height * zoom.scale - stage.height) / 2);
  return { scale: zoom.scale, x: clamp(zoom.x, -reachX, reachX), y: clamp(zoom.y, -reachY, reachY) };
}
