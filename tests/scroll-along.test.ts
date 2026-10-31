import test from "node:test";
import assert from "node:assert/strict";
import { scrollAlong, type ScrollAlongDeps, type Timed } from "../src/lib/scroll-along.ts";

/** A stand-in page and frame clock: frames run only when the test calls `tick`. */
function page() {
  const places: number[] = [];
  let queue: { handle: number; callback: () => void }[] = [];
  let next = 1, clock = 0;
  const deps: ScrollAlongDeps = {
    scrollTo: top => void places.push(top),
    frame: callback => { const handle = next++; queue.push({ handle, callback }); return handle; },
    cancelFrame: handle => { queue = queue.filter(item => item.handle !== handle); },
    now: () => clock,
  };
  const tick = (ms = 16) => { clock += ms; const run = queue; queue = []; for (const item of run) item.callback(); };
  return { deps, places, tick, pending: () => queue.length };
}

/** A stand-in motion whose progress (after easing) the test sets. */
function motion() {
  let settle!: () => void;
  const state = { progress: 0 as number | null, playState: "running" };
  const timed: Timed & { state: typeof state; end(): void } = {
    state,
    effect: { getComputedTiming: () => ({ progress: state.progress }) },
    get playState() { return state.playState; },
    finished: new Promise<void>(resolve => { settle = resolve; }),
    end() { state.progress = null; state.playState = "finished"; settle(); },
  };
  return timed;
}

test("the page follows the motion's own progress each frame and lands on the end with it", async () => {
  const { deps, places, tick } = page();
  const shrink = motion();
  const along = scrollAlong(shrink, 4000, -3000, 1000, deps);
  assert.deepEqual(places, [], "nothing moves before the first frame");
  tick();
  assert.deepEqual(places, [4000], "the press frame keeps the page where it is");
  shrink.state.progress = 0.25; tick();
  shrink.state.progress = 0.9; tick();
  assert.deepEqual(places, [4000, 3250, 1300]);
  shrink.end(); tick();
  await along.finished;
  assert.equal(places.at(-1), 1000);
});

test("the end is reached from the motion's finished promise even without another frame", async () => {
  const { deps, places, pending } = page();
  const shrink = motion();
  const along = scrollAlong(shrink, 500, -200, 1000, deps);
  shrink.end();
  await along.finished;
  assert.deepEqual(places, [300]);
  assert.equal(pending(), 0, "no frame is left running");
});

test("without a motion to follow (reduced motion) the page is set at once", async () => {
  const { deps, places } = page();
  const along = scrollAlong(undefined, 800, -300, 1000, deps);
  await along.finished;
  assert.deepEqual(places, [500]);
});

test("a press mid-motion stops the scroll where the page is, without jumping to the end", async () => {
  const { deps, places, tick, pending } = page();
  const shrink = motion();
  const along = scrollAlong(shrink, 1000, -400, 1000, deps);
  tick();
  shrink.state.progress = 0.5; tick();
  along.stop();
  shrink.end();
  await along.finished;
  assert.deepEqual(places, [1000, 800]);
  assert.equal(pending(), 0);
});

test("a motion that never reports its end is ended after the limit", async () => {
  const { deps, places, tick } = page();
  const shrink = motion();
  shrink.state.progress = 0.4;
  const along = scrollAlong(shrink, 100, 100, 300, deps);
  tick(200);
  tick(200);
  await along.finished;
  assert.deepEqual(places, [140, 200]);
});
