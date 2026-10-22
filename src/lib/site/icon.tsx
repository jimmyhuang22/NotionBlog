import "server-only";
import { ImageResponse } from "next/og";
import { getSiteConfig } from "./index.ts";
import { ICON_BOX, ICON_COLORS, ICON_STROKE, monogram, sealGlyphs, type IconTheme } from "./monogram.ts";

/** Tab icons in both themes, and the home-screen icon, which fills its square because the system rounds it. */
const variants = {
  light: { theme: "light", size: 96, radius: 14 },
  dark: { theme: "dark", size: 96, radius: 14 },
  apple: { theme: "light", size: 180, radius: 0 },
} as const satisfies Record<string, { theme: IconTheme; size: number; radius: number }>;

export type IconVariant = keyof typeof variants;

export function isIconVariant(value: string): value is IconVariant {
  return Object.hasOwn(variants, value);
}

/**
 * The site icon: the owner's initials as a seal. The name comes from the private site configuration
 * on every request, so no initials live in the repository; without a usable name it shows a pen stroke.
 */
export function siteIcon(variant: IconVariant): ImageResponse {
  const { theme, size, radius } = variants[variant];
  const { seal, mark } = ICON_COLORS[theme];
  const name = getSiteConfig().profile.name;
  const glyphs = name ? sealGlyphs(monogram(name)) : null;
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%" }}>
        <svg width={size} height={size} viewBox={`0 0 ${ICON_BOX} ${ICON_BOX}`}>
          <rect width={ICON_BOX} height={ICON_BOX} rx={radius} fill={seal} />
          {glyphs
            ? glyphs.map((glyph, index) => <path key={index} d={glyph.d} transform={glyph.transform} fill={mark} />)
            : <path d={ICON_STROKE} fill="none" stroke={mark} strokeWidth={6} strokeLinecap="round" />}
        </svg>
      </div>
    ),
    // The initials can change with the private configuration, so browsers keep the image for an hour only.
    { width: size, height: size, headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
