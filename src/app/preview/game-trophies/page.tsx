import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GamePage } from "@/components/work-detail";
import { getContentProvider } from "@/lib/content";
import { getSiteConfig } from "@/lib/site";
import type { ContentDocument, Game } from "../../../../contracts/content.ts";
import { fixtureDocuments, fixtureItems } from "../../../../fixtures/content.ts";
import { trophyCases } from "./demo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "游戏奖杯预览" };

type Props = { searchParams: Promise<{ case?: string }> };

/**
 * The game page with fictional trophies (decision 2026-11-20-game-trophies), one case at a time. The backend has
 * not delivered trophies yet and the demo fixtures carry none, so this page passes them to the real components.
 * Exists only while the site runs on demo data.
 */
export default async function TrophyPreviewPage({ searchParams }: Props) {
  if (getContentProvider() !== "mock") notFound();
  const key = (await searchParams).case ?? "full";
  const chosen = trophyCases[key];
  const base = fixtureItems.game.find(game => game.id === "mock-game-1");
  if (!chosen || !base) notFound();
  const item: Game = { ...base, title: `[演示] 奖杯 · ${chosen.label}`, platforms: chosen.sets.length ? ["PlayStation"] : ["Nintendo Switch"] };
  const empty: ContentDocument = { blocks: [], toc: [], completeness: "complete" };
  const document = chosen.body ? fixtureDocuments["mock-game-1"] ?? empty : empty;
  return (
    <>
      <nav className="wrap" aria-label="演示情形" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", paddingTop: 16 }}>
        <span className="tag tag--sky">演示内容</span>
        {Object.entries(trophyCases).map(([name, entry]) => (
          <Link key={name} prefetch={false} href={`/preview/game-trophies?case=${name}`} className="tag" aria-current={name === key ? "page" : undefined} style={name === key ? { outline: "2px solid var(--ink)" } : undefined}>{entry.label}</Link>
        ))}
        <span style={{ flexBasis: "100%", color: "var(--muted)", fontSize: "var(--text-sm)" }}>{chosen.note}</span>
      </nav>
      <GamePage type="games" label="游戏" item={item} document={document} timeZone={getSiteConfig().timeZone} neighbours={null} trophySets={chosen.sets} />
    </>
  );
}
