/**
 * How strongly each column of a block grows, from the width ratios the source gives (0.5 and 0.5,
 * or 50 and 50; null when it gives none). The narrowest column gets 1 and the others their share
 * of it. Factors below 1 would let a column that wraps onto a row of its own fill only part of it.
 */
export function columnGrowth(ratios: readonly (number | null)[]): number[] {
  const known = ratios.filter((ratio): ratio is number => typeof ratio === "number" && ratio > 0);
  const least = known.length ? Math.min(...known) : 1;
  return ratios.map(ratio => typeof ratio === "number" && ratio > 0 ? Math.round(ratio / least * 1000) / 1000 : 1);
}
