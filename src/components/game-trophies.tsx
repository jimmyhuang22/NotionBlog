"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { earnedByMonth, earnedPlatinum, gradeLabel, missingTrophies, rarestEarned, rarityTier, recentEarned, trophyDay, trophyPlatformTone, type Trophy, type TrophySet } from "../lib/game-trophies.ts";

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

function SetBody({ set }: { set: TrophySet }) {
  const trophies = set.trophies ?? [];
  const platinum = earnedPlatinum(trophies);
  // With the platinum as the banner, the cards and the list below do not show it again (round two, 2026-11-20).
  const rest = platinum ? trophies.filter(trophy => trophy !== platinum) : trophies;
  const rare = rarestEarned(rest);
  const earned = recentEarned(rest);
  const missing = missingTrophies(rest);
  const [open, setOpen] = useState<"none" | "all" | "missing">("none");
  const toggle = (which: "all" | "missing") => setOpen(current => current === which ? "none" : which);
  return (
    <>
      {platinum ? (
        <div className="game-trophies__platinum">
          <TrophyIcon trophy={platinum} large />
          <div><b>白金 · {nameOf(platinum)}</b>{detailOf(platinum) ? <span>{detailOf(platinum)}</span> : null}</div>
          <span className="game-trophies__platinum-when">
            {platinum.earnedDate ? trophyDay(platinum.earnedDate) : "日期未记录"}
            {platinum.rarityPercent !== null ? <small>全球 {platinum.rarityPercent}% 的玩家拿到</small> : null}
          </span>
        </div>
      ) : null}
      {rare.length ? (
        <ol className="game-trophies__rare" aria-label="最难拿到的">
          {rare.map(trophy => (
            <li key={trophy.id}>
              <TrophyIcon trophy={trophy} large />
              <b>{nameOf(trophy)}</b>
              {detailOf(trophy) ? <span className="game-trophies__rare-detail">{detailOf(trophy)}</span> : null}
              <span className="game-trophies__rare-meta">
                <Grade trophy={trophy} />
                <span className="game-trophies__tier">{rarityTier(trophy.rarityPercent!)}</span>
                <span className="game-trophy__rate"><span className="visually-hidden">全球获得率 </span>{trophy.rarityPercent}%</span>
              </span>
            </li>
          ))}
        </ol>
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
      ) : earned.length ? (
        <>
          <h3 className="game-trophies__sub">最近拿到</h3>
          <ul className="game-trophies__list">{earned.slice(0, RECENT).map(trophy => <Row key={trophy.id} trophy={trophy} />)}</ul>
        </>
      ) : <p className="game-trophies__none">还没有拿到奖杯。</p>}
      {open === "missing" ? (
        <>
          <h3 className="game-trophies__sub">还没拿到的 {missing.length} 个</h3>
          <ul className="game-trophies__list">{missing.map(trophy => <Row key={trophy.id} trophy={trophy} />)}</ul>
        </>
      ) : null}
      {earned.length > RECENT || missing.length ? (
        <p className="game-trophies__more">
          {earned.length > RECENT ? <button type="button" aria-expanded={open === "all"} onClick={() => toggle("all")}>{open === "all" ? "收起" : `全部 ${earned.length} 个`}</button> : null}
          {missing.length ? <button type="button" className="game-trophies__more-quiet" aria-expanded={open === "missing"} onClick={() => toggle("missing")}>{open === "missing" ? "收起未拿到" : `未拿到 ${missing.length} 个`}</button> : null}
        </p>
      ) : null}
    </>
  );
}

/**
 * The "奖杯" section under the write-up (layout 乙, 2026-11-20): the platinum as a banner when earned, the three
 * rarest as cards, the six most recent, and the rest behind two buttons. Several platforms each keep their own set
 * behind a switch beside the heading. Only sets the backend sent in full are here; the side summary covers the rest.
 */
export function GameTrophies({ sets }: { sets: TrophySet[] }) {
  const full = sets.filter(set => set.trophies?.length);
  const [chosen, setChosen] = useState(0);
  const base = useId();
  if (!full.length) return null;
  const current = full[Math.min(chosen, full.length - 1)]!;
  const label = (set: TrophySet) => `${set.earned} / ${set.total}`;
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
        <h2 id={`${base}-h`} className="game-trophies__title">奖杯{full.length === 1 ? <small>{sets.length > 1 ? <span className={`platform-chip platform-chip--${trophyPlatformTone(current.platform)}`}>{current.platform}</span> : null}{label(current)}</small> : null}</h2>
        {full.length > 1 ? (
          <div className="game-trophies__tabs" role="tablist" aria-label="平台" onKeyDown={onKey}>
            {full.map((set, index) => (
              <button key={set.id} type="button" role="tab" id={`${base}-t${index}`} aria-controls={`${base}-p`} aria-selected={index === chosen} tabIndex={index === chosen ? 0 : -1} onClick={() => setChosen(index)}>
                {set.platform}<small>{label(set)}</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div id={`${base}-p`} role={full.length > 1 ? "tabpanel" : undefined} aria-labelledby={full.length > 1 ? `${base}-t${chosen}` : undefined}>
        <SetBody key={current.id} set={current} />
      </div>
    </section>
  );
}
