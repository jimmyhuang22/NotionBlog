import { Fragment } from "react";
import { gamePlatformIcon, type GamePlatformIcon } from "../lib/library.ts";

/*
 * Single-colour outlines for the platforms a game is played on, filled with the text's own colour (F60,
 * the owner's pick 甲, 2026-11-22). Steam, PlayStation, Nintendo Switch and Nintendo 3DS are Simple Icons
 * (https://simpleicons.org, CC0), unchanged; each only names its platform and is never combined with
 * another mark. PC is a plain monitor drawn here, not a maker's logo.
 */
const PATHS: Record<GamePlatformIcon, string> = {
  steam: "M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z",
  playstation: "M8.984 2.596v17.547l3.915 1.261V6.688c0-.69.304-1.151.794-.991.636.18.76.814.76 1.505v5.875c2.441 1.193 4.362-.002 4.362-3.152 0-3.237-1.126-4.675-4.438-5.827-1.307-.448-3.728-1.186-5.39-1.502zm4.656 16.241l6.296-2.275c.715-.258.826-.625.246-.818-.586-.192-1.637-.139-2.357.123l-4.205 1.5V14.98l.24-.085s1.201-.42 2.913-.615c1.696-.18 3.785.03 5.437.661 1.848.601 2.04 1.472 1.576 2.072-.465.6-1.622 1.036-1.622 1.036l-8.544 3.107V18.86zM1.807 18.6c-1.9-.545-2.214-1.668-1.352-2.32.801-.586 2.16-1.052 2.16-1.052l5.615-2.013v2.313L4.205 17c-.705.271-.825.632-.239.826.586.195 1.637.15 2.343-.12L8.247 17v2.074c-.12.03-.256.044-.39.073-1.939.331-3.996.196-6.038-.479z",
  switch: "M14.176 24h3.674c3.376 0 6.15-2.774 6.15-6.15V6.15C24 2.775 21.226 0 17.85 0H14.1c-.074 0-.15.074-.15.15v23.7c-.001.076.075.15.226.15zm4.574-13.199c1.351 0 2.399 1.125 2.399 2.398 0 1.352-1.125 2.4-2.399 2.4-1.35 0-2.4-1.049-2.4-2.4-.075-1.349 1.05-2.398 2.4-2.398zM11.4 0H6.15C2.775 0 0 2.775 0 6.15v11.7C0 21.226 2.775 24 6.15 24h5.25c.074 0 .15-.074.15-.149V.15c.001-.076-.075-.15-.15-.15zM9.676 22.051H6.15c-2.326 0-4.201-1.875-4.201-4.201V6.15c0-2.326 1.875-4.201 4.201-4.201H9.6l.076 20.102zM3.75 7.199c0 1.275.975 2.25 2.25 2.25s2.25-.975 2.25-2.25c0-1.273-.975-2.25-2.25-2.25s-2.25.977-2.25 2.25z",
  "3ds": "M17.653 16.63a.712.712 0 1 0 1.424 0 .712.712 0 1 0-1.424 0m-9.45 4.238h7.575c.3 0 .524-.225.544-.524v-5.175c-.02-.282-.263-.525-.544-.507H8.203a.54.54 0 0 0-.544.525v5.156c0 .301.244.525.544.525zm13.051-3.525a.729.729 0 0 0 .73-.729.73.73 0 1 0-.73.729zm-1.443-.019a.714.714 0 1 0 .001 1.427.714.714 0 0 0-.001-1.427zm-.713-2.137a.712.712 0 1 0 1.424 0 .712.712 0 1 0-1.424 0M2.54 16.612a1.65 1.65 0 1 0 3.3 0 1.65 1.65 0 1 0-3.3 0M21.272 0H2.728A2.73 2.73 0 0 0-.01 2.72v18.542C.009 22.781 1.228 24 2.728 24h18.526a2.753 2.753 0 0 0 2.756-2.719V2.737C23.991 1.219 22.772 0 21.272 0zm1.913 21.281a1.92 1.92 0 0 1-1.912 1.912H2.728a1.92 1.92 0 0 1-1.913-1.912v-8.456h22.369v8.456zm0-9.694H.815v-8.85A1.92 1.92 0 0 1 2.728.824h18.544c1.049 0 1.912.863 1.912 1.913v8.85 M17.409 3.112H6.534c-.3 0-.544.263-.544.563V9.15c0 .3.226.563.544.563h10.875a.548.548 0 0 0 .544-.563V3.656a.543.543 0 0 0-.544-.544z",
  pc: "M3 2.5h18a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5H3A2.5 2.5 0 0 1 .5 15V5A2.5 2.5 0 0 1 3 2.5zm0 2.2a.3.3 0 0 0-.3.3v10a.3.3 0 0 0 .3.3h18a.3.3 0 0 0 .3-.3V5a.3.3 0 0 0-.3-.3zm7.9 12.8h2.2v2.8h-2.2zM7.6 19.8h8.8a1.1 1.1 0 0 1 0 2.2H7.6a1.1 1.1 0 0 1 0-2.2z",
};

/** A platform's outline, sized by its stylesheet (`.game-platform__icon`); hidden from screen readers, which hear the name. */
function GamePlatformIconMark({ icon }: { icon: GamePlatformIcon }) {
  return <svg className="game-platform__icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor"><path d={PATHS[icon]} /></svg>;
}

/**
 * The home timeline's date-row tag for a game (2026-11-19, the owner's pick 丙一), given its platforms as their chips
 * label them: "在 Switch 上玩", or "在玩" when none is recorded. Each platform it knows has its outline before the
 * name, in the tag's own colour (F60, 甲, 2026-11-22); a screen reader hears the same words as before. One inline
 * run inside the tag's flex box, so its spaces stay, and a platform's icon and name never part.
 */
export function GameTag({ platforms }: { platforms: string[] }) {
  if (!platforms.length) return "在玩";
  return (
    <span className="game-tag">
      在{" "}
      {platforms.map((label, index) => {
        const icon = gamePlatformIcon(label);
        return (
          <Fragment key={label}>
            {index ? <span className="game-tag__sep">、</span> : null}
            <span className="game-platform">{icon ? <GamePlatformIconMark icon={icon} /> : null}{label}</span>
          </Fragment>
        );
      })}
      {" "}上玩
    </span>
  );
}
