import type { Game, GameBoxArtLayout, GamePlatformPlayTime, ImageAsset } from "../../../contracts/content.ts";

export function gameCasePlatformKey(platform: string): string {
  const name = platform.trim().toLowerCase();
  if (/^(?:nintendo )?switch ?2$/u.test(name)) return "switch2";
  if (/^(?:nintendo )?switch$/u.test(name)) return "switch";
  if (/^(?:playstation(?: [45])?|ps[45])$/u.test(name)) return "playstation";
  if (/^(?:nintendo )?3ds$/u.test(name)) return "3ds";
  return name;
}

export function gameCaseAspectRatio(platform: string): number {
  const key = gameCasePlatformKey(platform);
  if (key === "switch" || key === "switch2" || key === "3ds") return 0.62;
  if (key === "playstation") return 0.79;
  return 0.71;
}

/** Original source pixels retained vertically by a centered cover fit. */
export function gameBoxArtEffectiveHeight(image: Pick<ImageAsset, "width" | "height">, platform: string): number | null {
  const { width, height } = image;
  if (width === null || height === null || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= width) return null;
  const ratio = gameCaseAspectRatio(platform);
  // The artwork slot sits inside the shell's horizontal (8.5%) and vertical
  // (6.8%) rims and below the platform strip (12.5% of the shell width).
  const slotRatio = 0.915 * ratio / (1 - 0.193 * ratio);
  return Math.min(height, Math.floor(width / slotRatio));
}

export function isGameBoxArtLayout(value: unknown): value is GameBoxArtLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { mode, window, printedSwitchMark, playStationModel } = value as Record<string, unknown>;
  if (playStationModel !== undefined && playStationModel !== "PS4" && playStationModel !== "PS5") return false;
  const keys = Object.keys(value);
  if (mode === "contain") return keys.every(key => key === "mode" || key === "playStationModel");
  return mode === "retail" && keys.every(key => ["mode", "window", "printedSwitchMark", "playStationModel"].includes(key)) &&
    (printedSwitchMark === undefined || printedSwitchMark === true) &&
    Array.isArray(window) && window.length === 4 && window.every(n => Number.isSafeInteger(n) && n >= 0) &&
    window[2] > 0 && window[3] > 0;
}

export function isUsableGameBoxArt(image: Pick<ImageAsset, "width" | "height">, platform: string, layout?: GameBoxArtLayout): boolean {
  if (!layout) return (gameBoxArtEffectiveHeight(image, platform) ?? 0) >= 560;
  const { width, height } = image;
  if (width === null || height === null || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 560 || height < 560) return false;
  if (layout.playStationModel && (gameCasePlatformKey(platform) !== "playstation" ||
      (/4|5/u.test(platform) && !platform.endsWith(layout.playStationModel.slice(-1))))) return false;
  if (layout.mode === "contain") return width / height >= 0.8 && width / height <= 1.25;
  const [left, top, artWidth, artHeight] = layout.window;
  if (layout.printedSwitchMark && gameCasePlatformKey(platform) !== "switch") return false;
  return left + artWidth <= width && top + artHeight <= height &&
    artHeight >= 560 && artWidth / artHeight >= 0.48 && artWidth / artHeight <= 1.12;
}

/** Snapshots publish hours and use the exact labels already present on Game. */
export function isGamePlatformPlayTime(value: unknown, platforms: readonly string[]): value is GamePlatformPlayTime[] | null {
  if (value === null) return true;
  if (!Array.isArray(value) || !value.length || value.length > platforms.length) return false;
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 2 ||
        typeof row.platform !== "string" || !platforms.includes(row.platform) || seen.has(row.platform)) return false;
    const time = row.time;
    if (!time || typeof time !== "object" || Array.isArray(time) || Object.keys(time).length !== 2 ||
        time.unit !== "hour" || !Number.isFinite(time.value) || time.value < 0) return false;
    seen.add(row.platform);
  }
  return true;
}

/** Both asset selection and the front-end strip use this exact platform. */
export function selectGameCasePlatform(game: Pick<Game, "platforms" | "lastPlayedPlatforms" | "platformPlayTime">): string | null {
  const recent = game.lastPlayedPlatforms ?? [];
  const hours = (time: GamePlatformPlayTime["time"]) => time.unit === "hour" ? time.value : time.value / 60;
  const rank = (platform: string) => {
    const index = recent.findIndex(value => gameCasePlatformKey(value) === gameCasePlatformKey(platform));
    return index < 0 ? recent.length : index;
  };
  const timed = (game.platformPlayTime ?? []).filter(({ platform, time }) =>
    game.platforms.includes(platform) && Number.isFinite(time.value) && time.value > 0);
  timed.sort((a, b) => hours(b.time) - hours(a.time) || rank(a.platform) - rank(b.platform) ||
    game.platforms.indexOf(a.platform) - game.platforms.indexOf(b.platform));
  if (timed[0]) return timed[0].platform;
  for (const observed of recent) {
    const match = game.platforms.find(platform => platform === observed) ??
      game.platforms.find(platform => gameCasePlatformKey(platform) === gameCasePlatformKey(observed));
    if (match) return match;
  }
  return game.platforms[0] ?? null;
}
