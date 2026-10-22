/**
 * The site's visual themes ("skins"). Each one fixes which colour schemes it offers and how it
 * arrives when the visitor switches to it. Ink is the default and needs no attribute on the root.
 */
export type Scheme = "light" | "dark";
export type SkinId = "ink" | "apple" | "island" | "y2k";
export type Transition = "spread" | "fade" | "pop" | "bubble";

export interface Skin {
  id: SkinId;
  label: string;
  /** The colour schemes the skin is drawn in; one entry means the scheme is fixed. */
  schemes: readonly Scheme[];
  /** How the skin takes over the page when it is chosen (globals.css, skins.css). */
  transition: Transition;
}

export const skins: readonly Skin[] = [
  { id: "ink", label: "墨水", schemes: ["light", "dark"], transition: "spread" },
  { id: "apple", label: "苹果", schemes: ["light", "dark"], transition: "fade" },
  { id: "island", label: "岛屿", schemes: ["light", "dark"], transition: "pop" },
  { id: "y2k", label: "千禧", schemes: ["light"], transition: "bubble" },
];

export const DEFAULT_SKIN: SkinId = "ink";

export function isSkin(value: unknown): value is SkinId {
  return skins.some(skin => skin.id === value);
}

/** Skins that were replaced: a visitor who had chosen one arrives at its successor, keeping their light/dark choice. */
export const replacedSkins: Readonly<Record<string, SkinId>> = { note: "island" };

/** A stored skin as it is used now: a replaced one becomes its successor; anything unknown stays as it is. */
export function currentSkin(value: unknown): unknown {
  return typeof value === "string" && value in replacedSkins ? replacedSkins[value] : value;
}

export function isScheme(value: unknown): value is Scheme {
  return value === "light" || value === "dark";
}

export function skinOf(id: SkinId): Skin {
  return skins.find(skin => skin.id === id) ?? skins[0]!;
}

/** The skin `steps` places after `id` in the list above (negative for before), wrapping round at either end. */
export function skinAfter(id: SkinId, steps: number): SkinId {
  const from = Math.max(0, skins.findIndex(skin => skin.id === id));
  return skins[(((from + steps) % skins.length) + skins.length) % skins.length]!.id;
}

/** The scheme a skin shows: its only one, or the stored choice, or whatever the system prefers. */
export function schemeFor(skin: SkinId, stored: Scheme | null, system: Scheme): Scheme {
  const { schemes } = skinOf(skin);
  if (schemes.length === 1) return schemes[0]!;
  return stored && schemes.includes(stored) ? stored : system;
}

/** The root attributes for a skin and stored scheme; a null theme means "follow the system". */
export function rootAttributes(skin: SkinId, stored: Scheme | null): { skin: SkinId | null; theme: Scheme | null } {
  const { schemes } = skinOf(skin);
  return {
    skin: skin === DEFAULT_SKIN ? null : skin,
    theme: schemes.length === 1 ? schemes[0]! : stored && schemes.includes(stored) ? stored : null,
  };
}

/**
 * Runs before paint so a stored choice never flashes the default look. Generated from the list
 * above: the skins with one scheme force it, the others keep the stored light/dark choice.
 */
export const themeScript = `try{var d=document.documentElement,s=localStorage.getItem("skin"),t=localStorage.getItem("theme"),r=${JSON.stringify(replacedSkins)},f=${JSON.stringify(Object.fromEntries(skins.filter(skin => skin.schemes.length === 1).map(skin => [skin.id, skin.schemes[0]])))};if(r.hasOwnProperty(s))s=r[s];if(${JSON.stringify(skins.filter(skin => skin.id !== DEFAULT_SKIN).map(skin => skin.id))}.indexOf(s)>=0)d.dataset.skin=s;else s="${DEFAULT_SKIN}";if(f[s])t=f[s];if(t==="light"||t==="dark")d.dataset.theme=t}catch(e){}`;
