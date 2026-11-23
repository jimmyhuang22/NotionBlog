"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { earnedByMonth, earnedPlatinum, gradeLabel, missingTrophies, rarestEarned, rarityTier, recentEarned, setPlatinum, trophyDay, trophySpan, type Trophy, type TrophySet } from "../lib/game-trophies.ts";
import { PlatinumCup, TrophyPlatform } from "./trophy-marks";

const RECENT = 6;

/** The trophy's picture from site media; a cup in its grade's colour when there is none, a lock while it is hidden. */
function TrophyIcon({ trophy, large = false }: { trophy: Trophy; large?: boolean }) {
  const size = large ? " game-trophy__icon--lg" : "";
  const off = trophy.earned ? "" : " game-trophy__icon--off";
  const veiled = veiledTrophy(trophy);
  // Platform icons are small originals (Steam's are 64×64): shown at 40 or 48 px, never stretched past that.
  if (trophy.icon && !veiled) return <img className={`game-trophy__icon${size}${off}`} src={trophy.icon.src} alt="" width={64} height={64} loading="lazy" decoding="async" />;
  return (
    <span className={`game-trophy__icon game-trophy__icon--blank game-trophy__icon--${trophy.grade ?? "none"}${size}${off}`} aria-hidden="true">
      <svg viewBox="0 0 24 24">{veiled
        ? <path d="M7.5 11V8.5a4.5 4.5 0 0 1 9 0V11M6 11h12v9H6z" />
        : <path d="M7.5 4h9v3.5a4.5 4.5 0 0 1-9 0zM7.5 5.5H5a2.5 2.5 0 0 0 2.6 3.4M16.5 5.5H19a2.5 2.5 0 0 1-2.6 3.4M12 12v3.5M9 19.5h6M10 15.5h4v4h-4z" />}</svg>
    </span>
  );
}

/** A hidden trophy not yet earned shows nothing of itself, even if a response carried it. */
const veiledTrophy = (trophy: Trophy) => trophy.hidden && !trophy.earned;
const nameOf = (trophy: Trophy) => veiledTrophy(trophy) ? "隐藏奖杯" : trophy.name ?? "名称未记录";
const detailOf = (trophy: Trophy) => veiledTrophy(trophy) ? "拿到后显示" : trophy.detail;

function Grade({ trophy }: { trophy: Trophy }) {
  return trophy.grade ? <span className={`game-trophy__grade game-trophy__grade--${trophy.grade}`}>{gradeLabel[trophy.grade]}</span> : null;
}

function Row({ trophy, withYear = true }: { trophy: Trophy; withYear?: boolean }) {
  const detail = detailOf(trophy);
  return (
    <li className={trophy.earned ? "game-trophy-row" : "game-trophy-row game-trophy-row--off"}>
      <TrophyIcon trophy={trophy} />
      <div className="game-trophy-row__text"><b>{nameOf(trophy)}</b>{detail ? <span>{detail}</span> : null}</div>
      <span className="game-trophy-row__meta">
        {trophy.earned ? <span>{trophy.earnedDate ? trophyDay(trophy.earnedDate, withYear) : "日期未记录"}</span> : null}
        <span><Grade trophy={trophy} />{trophy.rarityPercent !== null ? <span className="game-trophy__rate"><span className="visually-hidden">全球获得率 </span>{trophy.rarityPercent}%</span> : null}</span>
      </span>
    </li>
  );
}

/**
 * When the trophies came, in one quiet line under the heading (甲, 2026-11-22, in place of round three's month bars):
 * "2023 年 1 月 24 日拿到第一个，第 12 天拿到白金", or from the first day to the last and how many.
 */
function TrophySpan({ trophies }: { trophies: Trophy[] }) {
  const span = trophySpan(trophies);
  if (!span) return null;
  return (
    <p className="game-trophy-span">
      {span.platinum ? <PlatinumCup className="game-trophy-span__cup" /> : null}
      {span.parts.map((part, index) => part.strong ? <b key={index}>{part.text}</b> : <span key={index}>{part.text}</span>)}
    </p>
  );
}

function SetBody({ set, spanInStrip = false }: { set: TrophySet; spanInStrip?: boolean }) {
  const trophies = set.trophies ?? [];
  const platinum = earnedPlatinum(trophies);
  // With the platinum as the banner, the cards and the list below do not show it again (round two, 2026-11-20).
  const rest = platinum ? trophies.filter(trophy => trophy !== platinum) : trophies;
  const rare = rarestEarned(rest);
  const earned = recentEarned(rest);
  const missing = missingTrophies(rest);
  // The cards are not repeated in the recent list just under them; the full list still has every one (甲, 2026-11-23).
  const recent = earned.filter(trophy => !rare.includes(trophy)).slice(0, RECENT);
  const [open, setOpen] = useState<"none" | "all" | "missing">("none");
  const toggle = (which: "all" | "missing") => setOpen(current => current === which ? "none" : which);
  return (
    <>
      {spanInStrip ? null : <TrophySpan trophies={trophies} />}
      {platinum ? (
        <div className="game-trophies__platinum">
          <TrophyIcon trophy={platinum} large />
          <div><b><small className="game-trophies__platinum-label">白金<span className="visually-hidden">：</span></small>{nameOf(platinum)}</b>{detailOf(platinum) ? <span>{detailOf(platinum)}</span> : null}</div>
          <span className="game-trophies__platinum-when">
            {platinum.earnedDate ? trophyDay(platinum.earnedDate) : "日期未记录"}
            {platinum.rarityPercent !== null ? <small>全球 {platinum.rarityPercent}% 的玩家拿到</small> : null}
          </span>
        </div>
      ) : null}
      {rare.length ? (
        <>
        <h3 className="game-trophies__sub">最难拿到的</h3>
        <ol className={`game-trophies__rare${rare.length === 1 ? " game-trophies__rare--one" : ""}`}>
          {rare.map(trophy => (
            <li key={trophy.id} className={`game-trophies__medal game-trophies__medal--${trophy.grade ?? "none"}`}>
              <TrophyIcon trophy={trophy} large />
              <b>{nameOf(trophy)}</b>
              {detailOf(trophy) ? <span className="game-trophies__rare-detail">{detailOf(trophy)}</span> : null}
              <span className="game-trophies__rare-meta">
                <Grade trophy={trophy} />
                <span>{rarityTier(trophy.rarityPercent!)} <span className="game-trophy__rate"><span className="visually-hidden">全球获得率 </span>{trophy.rarityPercent}%</span></span>
              </span>
            </li>
          ))}
        </ol>
        </>
      ) : null}
      {open === "all" ? (
        <>
          <h3 className="game-trophies__sub">拿到的 {earned.length} 个</h3>
          {earnedByMonth(rest).map(group => (
            <section key={group.key} className="game-trophies__month" aria-label={group.label}>
              <h4>{group.label}<small>{group.trophies.length} 个</small></h4>
              <ul className="game-trophies__list">{group.trophies.map(trophy => <Row key={trophy.id} trophy={trophy} withYear={group.key === "undated"} />)}</ul>
            </section>
          ))}
        </>
      ) : recent.length ? (
        <>
          <h3 className="game-trophies__sub">最近拿到</h3>
          <ul className="game-trophies__list">{recent.map(trophy => <Row key={trophy.id} trophy={trophy} />)}</ul>
        </>
      ) : earned.length ? null : <p className="game-trophies__none">还没有拿到奖杯。</p>}
      {open === "missing" ? (
        <>
          <h3 className="game-trophies__sub">还没拿到的 {missing.length} 个</h3>
          <ul className="game-trophies__list">{missing.map(trophy => <Row key={trophy.id} trophy={trophy} />)}</ul>
        </>
      ) : null}
      {earned.length > recent.length + rare.length || missing.length ? (
        <p className="game-trophies__more">
          {earned.length > recent.length + rare.length ? <button type="button" aria-expanded={open === "all"} onClick={() => toggle("all")}>{open === "all" ? "收起" : `全部 ${earned.length} 个`}</button> : null}
          {missing.length ? <button type="button" className="game-trophies__more-quiet" aria-expanded={open === "missing"} onClick={() => toggle("missing")}>{open === "missing" ? "收起未拿到" : `未拿到 ${missing.length} 个`}</button> : null}
        </p>
      ) : null}
    </>
  );
}

/**
 * A platform tab's count (乙, 2026-11-22): a set with its platinum says so with the cup, "白金" when every trophy is
 * earned and the count beside the cup when some (often a later add-on's) are still missing.
 */
function TabCount({ set }: { set: TrophySet }) {
  const platinum = setPlatinum(set);
  return (
    <small>
      {platinum ? <PlatinumCup className="game-trophies__tab-cup" /> : null}
      {platinum && set.earned === set.total ? <>白金<span className="visually-hidden">，{set.earned} / {set.total}</span></> : `${set.earned} / ${set.total}`}
    </small>
  );
}

/**
 * The "奖杯" section under the write-up (layout 乙, 2026-11-20): the platinum as a banner when earned, the rarest
 * as cards under "最难拿到的" (only those a fifth of players or fewer have, 2026-11-23), the six most recent not
 * already shown as cards, and the rest behind two buttons. Several platforms each keep their own set behind a switch
 * beside the heading; one set names its platform there instead of repeating the count the side column gives. When
 * the date strip already says how many came within the owner's dates (`spanInStrip`), the line of when they came is
 * left out. Only sets the backend sent in full are here; the side summary covers the rest.
 */
export function GameTrophies({ sets, spanInStrip = false }: { sets: TrophySet[]; spanInStrip?: boolean }) {
  const full = sets.filter(set => set.trophies?.length);
  const [chosen, setChosen] = useState(0);
  const base = useId();
  if (!full.length) return null;
  const current = full[Math.min(chosen, full.length - 1)]!;
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (chosen + step + full.length) % full.length;
    setChosen(next);
    (event.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <section className="game-trophies card" aria-labelledby={`${base}-h`}>
      <div className="game-trophies__head">
        <h2 id={`${base}-h`} className="game-trophies__title">奖杯{full.length === 1 ? <small><TrophyPlatform platform={current.platform} /></small> : null}</h2>
        {full.length > 1 ? (
          <div className="game-trophies__tabs" role="tablist" aria-label="平台" onKeyDown={onKey}>
            {full.map((set, index) => (
              <button key={set.id} type="button" role="tab" id={`${base}-t${index}`} aria-controls={`${base}-p`} aria-selected={index === chosen} tabIndex={index === chosen ? 0 : -1} onClick={() => setChosen(index)}
                className={setPlatinum(set) ? "game-trophies__tab--platinum" : set.earned === 0 ? "game-trophies__tab--none" : undefined}>
                <TrophyPlatform platform={set.platform} /><TabCount set={set} />
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div id={`${base}-p`} role={full.length > 1 ? "tabpanel" : undefined} aria-labelledby={full.length > 1 ? `${base}-t${chosen}` : undefined}>
        <SetBody key={current.id} set={current} spanInStrip={spanInStrip && full.length === 1} />
      </div>
    </section>
  );
}
