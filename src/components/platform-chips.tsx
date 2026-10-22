import type { PlatformChip } from "../lib/library.ts";

/** A game's platforms as boxes in their makers' colours (library.css `.platform-chip`), on its card and its page alike. */
export function PlatformChips({ chips }: { chips: PlatformChip[] }) {
  return <>{chips.map(chip => <span key={chip.label} className={`platform-chip platform-chip--${chip.tone}`}>{chip.label}</span>)}</>;
}
