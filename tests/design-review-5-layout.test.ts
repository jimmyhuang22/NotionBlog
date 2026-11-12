import test from "node:test";
import assert from "node:assert/strict";
import { feedRuns, joinGames } from "../src/lib/timeline.ts";

type Item = { id: string; source: string; kind: "game" | "status" | "movie" | "work"; occurredAt: { start: string; end: null; precision: "date" } | null };
const item = (id: string, kind: Item["kind"], day: string | null): Item => ({ id, source: kind === "work" ? "social" : "content", kind, occurredAt: day ? { start: day, end: null, precision: "date" } : null });
const isGame = (entry: Item) => entry.kind === "game";
const runs = (items: Item[]) => joinGames(feedRuns(items, "UTC"), "UTC", isGame).map(run => run.items.map(entry => entry.id).join("+"));

test("neighbouring games in one month read as one line; anything between them, or a new month, keeps them apart", () => {
  assert.deepEqual(runs([
    item("s1", "status", "2026-10-31"),
    item("g1", "game", "2026-10-30"), item("g2", "game", "2026-10-29"), item("g3", "game", "2026-10-28"),
    item("m1", "movie", "2026-10-27"),
    item("g4", "game", "2026-10-26"),
    item("s2", "status", "2026-10-25"),
    item("g5", "game", "2026-10-02"), item("g6", "game", "2026-09-30"),
  ]), ["s1", "g1+g2+g3", "m1", "g4", "s2", "g5", "g6"]);
});

test("joining games keeps every entry, in the feed's order, and leaves runs of works as they were", () => {
  const items = [item("w1", "work", "2026-10-30"), item("w2", "work", "2026-10-29"), item("g1", "game", "2026-10-28"), item("g2", "game", "2026-10-28")];
  assert.deepEqual(runs(items), ["w1+w2", "g1+g2"]);
  assert.deepEqual(joinGames(feedRuns(items, "UTC"), "UTC", isGame).flatMap(run => run.items.map(entry => entry.id)), items.map(entry => entry.id));
  // Each joined run starts where its first entry stood, so the first screen's drawing order holds.
  assert.deepEqual(joinGames(feedRuns(items, "UTC"), "UTC", isGame).map(run => run.first), [0, 2]);
});
