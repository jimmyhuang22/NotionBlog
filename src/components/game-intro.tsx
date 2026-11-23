"use client";

import { useEffect, useId, useRef, useState } from "react";

/** Paragraphs are separated by a blank line; a single line break stays a line break inside its paragraph. */
export function introParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/u).map(part => part.trim()).filter(Boolean);
}

/**
 * The game's story on its art (2026-11-24, round six of the game page): two lines on a dark, frosted ground so they
 * read on bright art too, and "简介全文" opening the rest in place ("收起" closes it). Whether there is more than two
 * lines is measured once the page is drawn; until then a story of one short paragraph shows no button.
 */
export function GameIntro({ text }: { text: string }) {
  const paragraphs = introParagraphs(text);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(paragraphs.length > 1 || text.length > 60);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const element = box.current;
    if (element && !open) setMore(element.scrollHeight > element.clientHeight + 1);
  }, [open]);
  if (!paragraphs.length) return null;
  return (
    <div className="game-intro">
      {/* The ground's padding sits outside the clamped lines, so no part of a third line shows through it. */}
      <div id={id} className="game-intro__text">
        <div ref={box} className={open ? "game-intro__body" : "game-intro__body game-intro__body--clamp"}>
          {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
      </div>
      {more || open ? <button type="button" className="game-intro__more" aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)}>{open ? "收起" : "简介全文"}</button> : null}
    </div>
  );
}
