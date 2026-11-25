import { gamePlatformIconPath } from "./game-tag";

/*
 * The marks printed on real game cases, drawn to the owner's photos of a PS5, a PS4, a Switch 2 and a Switch case
 * (2026-11-24): every block is laid out in that photo's own pixels, and library.css sizes it by the case's width, so the
 * proportions hold from the 300-pixel stage to a 150-pixel phone shelf. Unlike the platform tags (game-tag.tsx), these
 * put the PS mark beside the model and NINTENDO SWITCH beside its mark, because that is what the printed case shows.
 * The PS5 and PS4 word marks are Simple Icons (https://simpleicons.org, CC0), unchanged; the type is drawn as text
 * stretched to the measured width. All are decoration: the case's link says the game's name.
 */
const PS_WORDMARKS = {
  ps5: { box: "0 9.425 24 5.15", path: "M10.4499 14.56905a1.38287 1.38287 0 001.38287-1.38287v-2.37841a.83315.83315 0 01.83416-.83315h2.68403a.03732.03732 0 00.03631-.03732V9.4612a.03631.03631 0 00-.0363-.0363H12.1172a1.38287 1.38287 0 00-1.38388 1.38286v2.38043a.83416.83416 0 01-.83315.83415H7.25347a.03631.03631 0 00-.03631.03632v.47608a.03631.03631 0 00.03631.03631zm6.04488-3.21156V9.4612a.03631.03631 0 01.0363-.0363h7.30772a.03732.03732 0 01.03732.0363v.47609a.03833.03833 0 01-.03732.03732h-6.20929a.03631.03631 0 00-.0363.03631v1.2356a.3954.3954 0 00.3964.39741h4.62267a1.46457 1.46457 0 010 2.9251h-6.0812a.03631.03631 0 01-.0363-.0363v-.47407a.03631.03631 0 01.0363-.03632h5.53047a.91586.91586 0 10-.00706-1.8307h-4.72656a.83315.83315 0 01-.83315-.83416m-10.84608.28645a.83466.83466 0 000-1.66932H.03654a.03732.03732 0 01-.03632-.03732V9.4612a.03631.03631 0 01.03632-.0363h6.1528a1.38388 1.38388 0 010 2.76673H1.9328a.83315.83315 0 00-.83315.83416v1.51299a.03631.03631 0 01-.03631.0363H.03654a.03631.03631 0 01-.03632-.04034v-1.51298a1.38287 1.38287 0 011.38388-1.37783Z" },
  ps4: { box: "0 9.436 24 5.128", path: "M12.302 13.18v-2.387c0-.486.227-.834.712-.834h2.99c.017 0 .035-.018.035-.036v-.475c0-.004 0-.008-.003-.012h-3.66c-.792.1-1.18.653-1.18 1.357v2.386c0 .482-.233.831-.71.831H7.332c-.018 0-.036.012-.036.036v.475c0 .02.01.035.023.04h3.584c.933-.025 1.393-.62 1.393-1.385zM.024 14.564h1.05a.042.042 0 00.025-.04v-1.52c0-.487.275-.823.676-.823h4.323c.974 0 1.445-.6 1.445-1.384 0-.705-.386-1.257-1.18-1.357H.006c0 .003-.006.005-.006.01v.475c0 .024.013.036.037.036h5.697c.484 0 .712.35.712.833 0 .484-.227.836-.712.836H1.226c-.7 0-1.226.592-1.226 1.373v1.519c0 .02.01.036.028.04zm15.998-.55h5.738c.017 0 .03.012.03.024v.483c0 .024.017.036.035.036h1.035c.018 0 .036-.01.036-.036v-.475c0-.018.02-.036.04-.036h1.028c.024 0 .036-.018.036-.036v-.484c0-.018-.01-.036-.035-.036h-1.03c-.02 0-.037-.017-.037-.035V9.96c0-.283-.104-.463-.28-.523h-.3a1.153 1.153 0 00-.303.132l-6.18 3.815c-.24.15-.323.318-.263.445.048.104.185.182.454.182zm.895-.637l4.79-2.961c.03-.024.09-.018.09.048v2.961c0 .018-.016.036-.034.036h-4.817c-.04 0-.06-.012-.065-.024-.006-.024.005-.042.036-.06z" },
} as const;
const NINTENDO_TYPE = "'Avenir Next', 'Arial Rounded MT Bold', 'Helvetica Neue', Arial, sans-serif";

/** PS mark 57x43, then the model's word mark 125x27 sixteen pixels after it (PS5 photo); without a model, the mark alone. */
export function PlayStationBandMark({ model }: { model: "ps5" | "ps4" | null }) {
  const mark = model ? PS_WORDMARKS[model] : null;
  return (
    <svg className={`case-mark case-mark--ps${mark ? "" : " case-mark--ps-only"}`} viewBox={mark ? "0 0 198 43" : "0 0 57 43"} aria-hidden="true" focusable="false">
      <svg x="0" y="0" width="57" height="43" viewBox="0 2.45 24 19.1" preserveAspectRatio="none"><path fill="currentColor" d={gamePlatformIconPath("playstation")} /></svg>
      {mark ? <svg x="73" y="8" width="125" height="27" viewBox={mark.box} preserveAspectRatio="none"><path fill="currentColor" d={mark.path} /></svg> : null}
    </svg>
  );
}

/** Switch 2's logo block, 71x62, centred in its band: the Joy-Con mark and a 2, NINTENDO spaced out, SWITCH below. */
export function Switch2BandMark() {
  return (
    <svg className="case-mark case-mark--switch2" viewBox="0 0 71 62" aria-hidden="true" focusable="false" fill="currentColor">
      <svg x="0" y="0" width="34" height="37.5" viewBox="0 0 24 24" preserveAspectRatio="none"><path d={gamePlatformIconPath("switch")} /></svg>
      <text x="41" y="37.3" fontFamily={NINTENDO_TYPE} fontWeight="800" fontSize="52" textLength="30" lengthAdjust="spacingAndGlyphs">2</text>
      <text x="3" y="50" fontFamily={NINTENDO_TYPE} fontWeight="700" fontSize="6.3" textLength="63" lengthAdjust="spacing">NINTENDO</text>
      <text x="2" y="61.6" fontFamily={NINTENDO_TYPE} fontWeight="800" fontSize="14" textLength="64" lengthAdjust="spacingAndGlyphs">SWITCH</text>
    </svg>
  );
}

/*
 * The Nintendo 3DS logo as printed on the case (Wikimedia Commons "Nintendo 3DS logo.svg", public domain), unchanged:
 * NINTENDO, the two-screen mark, a red 3, DS and the trade mark, 132 by 15.6.
 */
const LOGO_3DS = {
  tm: "M128.7,13.5h0.5V15h0.3v-1.5h0.5v-0.3h-1.3V13.5z M131.9,13.2h-0.4l-0.2,0.7c-0.1,0.2-0.1,0.4-0.2,0.6h0 c0-0.2-0.1-0.4-0.2-0.6l-0.2-0.7h-0.4l-0.1,1.7h0.3l0-0.7c0-0.2,0-0.5,0-0.7h0c0,0.2,0.1,0.4,0.2,0.7l0.2,0.7h0.2l0.2-0.7 c0.1-0.2,0.2-0.4,0.2-0.7h0c0,0.2,0,0.5,0,0.7l0,0.7h0.3L131.9,13.2z",
  screen: "M68.7,8.3h-5.9c-0.8,0-1.5,0.7-1.5,1.5V14c0,0.8,0.7,1.5,1.5,1.5h5.9c0.8,0,1.5-0.7,1.5-1.5V9.8 C70.3,9,69.6,8.3,68.7,8.3 M69,14c0,0.2-0.1,0.3-0.3,0.3h-5.8c-0.2,0-0.3-0.1-0.3-0.3V9.8c0-0.2,0.1-0.3,0.3-0.3h5.8 c0.2,0,0.3,0.1,0.3,0.3V14z",
  ink: "M23,1.4h3.2v6h1.4v-6h3.2V0.1H23V1.4z M20.1,5.4l-5.5-5.3h-1.1v7.3h1.3V2l5.5,5.4h1.1V0.1h-1.3V5.4z M10,7.4h1.4V0.1H10 V7.4z M6.6,5.4L1.2,0.1H0v7.3h1.3V2l5.5,5.4h1.1V0.1H6.6V5.4z M32.4,7.4h7.1V6.1h-5.8V4.3h4.5V3h-4.5V1.4h5.8V0.1h-7.1V7.4z M48.1,5.4l-5.5-5.3h-1.2v7.3h1.3V2l5.5,5.4h1.1V0.1h-1.3V5.4z M121.6,6.4c-2.9-1-4.5-1.6-4.5-2.8c0-0.8,1.1-1.6,3.5-1.6 c2.3,0,3.8,0.5,5.5,0.9l0-2.4c-1.7-0.3-2.6-0.5-5.3-0.5c-5,0-8.3,1.5-8.3,4c0,2.4,2.7,3.5,6.5,4.9c2.8,1,3.8,1.6,3.8,2.6 c0,1.1-1,2-3.6,2c-2.3,0-5.2-0.4-6.7-1v2.6c2,0.3,3.7,0.5,6.3,0.5c6.2,0,9-1.8,9-4.2C127.8,8.9,125.6,7.8,121.6,6.4z M107.2,1.2 c-1.5-0.7-4.2-1.1-6.7-1.1h-9.3v15.5h9.3c2.4,0,5.2-0.4,6.7-1.1c3.6-1.6,4.7-4.2,4.7-6.6C112,5.4,110.8,2.8,107.2,1.2z M99.3,13.4 h-3V2.2h3c4.6,0,7.4,2,7.4,5.6C106.7,11.5,103.8,13.4,99.3,13.4z M56.9,0.1h-5.4v7.3h5.4c0.9,0,1.7-0.4,2.3-1.1 c0.5-0.6,0.8-1.5,0.8-2.6c0-1-0.3-1.9-0.8-2.6C58.6,0.5,57.9,0.1,56.9,0.1z M57,6.1h-4.1V1.4H57c1.3,0,1.8,1.3,1.8,2.4 C58.7,4.9,58.2,6.1,57,6.1z M68.7,0.1h-5.9c-0.8,0-1.5,0.7-1.5,1.5v4.2c0,0.8,0.7,1.5,1.5,1.5h5.9c0.8,0,1.5-0.7,1.5-1.5V1.7 C70.3,0.8,69.6,0.1,68.7,0.1z M69,5.9c0,0.2-0.1,0.3-0.3,0.3h-5.8c-0.2,0-0.3-0.1-0.3-0.3V1.7c0-0.2,0.1-0.3,0.3-0.3h5.8 c0.2,0,0.3,0.1,0.3,0.3V5.9z",
  three: "M84.8,7.1c0,0,4.3-0.7,4.3-3.4c0-2.6-4.6-3.7-9.5-3.7c-4.4,0-7.3,0.5-7.3,0.5v2.4c2-0.5,3.9-0.9,6.5-0.9 c2.8,0,4.9,0.8,4.9,2c0,1.4-2.1,2.2-6.7,2.2H75v2.2h2c4.8,0,7.5,0.7,7.5,2.5c0,1.6-2.4,2.5-5.5,2.5c-2.7,0-5.1-0.6-7-1.1v2.6 c1,0.2,3.5,0.7,8.1,0.7c5.2,0,9.7-1.7,9.7-4.6C89.8,8.5,86.6,7.1,84.8,7.1",
};

/**
 * The Japanese 3DS case's side band (the owner's request, 2026-11-25): a white strip down the right edge with the logo on its side,
 * reading bottom to top, letters' tops toward the art. library.css places the band and the logo where they are on
 * the Japanese retail cases.
 */
export function ThreeDsBand() {
  return (
    <span className="case-band-3ds" aria-hidden="true">
      <svg className="case-mark case-mark--3ds" viewBox="0 0 132 15.6" focusable="false">
        <path fill="#231f20" d={LOGO_3DS.tm} />
        <path fill="#8c8c8c" d={LOGO_3DS.screen} />
        <path fill="#231f20" d={LOGO_3DS.ink} />
        <path fill="#ce181e" d={LOGO_3DS.three} />
      </svg>
    </span>
  );
}

/** Switch's red tile, 104x103, flush with the cover's top-left corner: the mark, NINTENDO and SWITCH under it. */
export function SwitchTile() {
  return (
    <svg className="case-mark case-mark--switch" viewBox="0 0 104 103" aria-hidden="true" focusable="false">
      <rect width="104" height="103" fill="#e40011" />
      <g fill="#fff">
        <svg x="31" y="15" width="45" height="46" viewBox="0 0 24 24" preserveAspectRatio="none"><path d={gamePlatformIconPath("switch")} /></svg>
        <text x="21" y="73.4" fontFamily={NINTENDO_TYPE} fontWeight="700" fontSize="6.9" textLength="66" lengthAdjust="spacing">NINTENDO</text>
        <text x="20" y="87" fontFamily={NINTENDO_TYPE} fontWeight="800" fontSize="15.3" textLength="70" lengthAdjust="spacingAndGlyphs">SWITCH</text>
      </g>
    </svg>
  );
}
