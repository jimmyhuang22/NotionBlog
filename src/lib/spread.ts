/**
 * How far a circle centred on (x, y) has to grow to cover a viewport of the given size:
 * the distance to the farthest corner, plus the soft edge that trails behind the front.
 */
export function spreadRadius(x: number, y: number, width: number, height: number, edge = 0): number {
  return Math.ceil(Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) + edge);
}
