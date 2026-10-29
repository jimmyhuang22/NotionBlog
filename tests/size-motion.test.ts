import test from "node:test";
import assert from "node:assert/strict";
import { CLOSE_MS, EASE, OPEN_MS, createSizeMotion, heightKeyframes, widthKeyframes, type Sizable } from "../src/lib/size-motion.ts";

/** A stand-in element: a size that tests change between capture and play, and a record of animate calls. */
function element(width: number, height: number) {
  const calls: { keyframes: Keyframe[]; options: KeyframeAnimationOptions; finished: number }[] = [];
  const box = { width, height };
  const el: Sizable & { box: typeof box; calls: typeof calls } = {
    box, calls,
    getBoundingClientRect: () => ({ ...box }),
    animate(keyframes, options) { const call = { keyframes, options, finished: 0 }; calls.push(call); return { finish() { call.finished += 1; } }; },
  };
  return el;
}

test("an opening card eases its body's height, clipped there, without fading; the card itself is not clipped", () => {
  const motion = createSizeMotion(() => false);
  const card = element(600, 220), body = element(552, 180);
  motion.capture(card, body, true);
  body.box.height = 640;
  motion.play(card, body);
  assert.equal(card.calls.length, 0);
  assert.equal(body.calls.length, 1);
  assert.deepEqual(body.calls[0]!.keyframes, [{ height: "180px", overflow: "clip" }, { height: "640px", overflow: "clip" }]);
  assert.deepEqual(body.calls[0]!.options, { duration: OPEN_MS, easing: EASE });
  assert.ok(body.calls[0]!.keyframes.every(frame => !("opacity" in frame) && !("clipPath" in frame)));
});

test("closing uses the shorter duration, and a short entry that widens moves the card's width, unclipped", () => {
  const motion = createSizeMotion(() => false);
  const card = element(320, 160), body = element(272, 120);
  motion.capture(card, body, false);
  card.box.width = 600; body.box.height = 90;
  motion.play(card, body);
  assert.equal(body.calls[0]!.options.duration, CLOSE_MS);
  assert.deepEqual(card.calls[0]!.keyframes, [{ width: "320px" }, { width: "600px" }]);
  assert.equal(card.calls[0]!.options.duration, CLOSE_MS);
});

test("with reduced motion the change is immediate: animate is never called", () => {
  const motion = createSizeMotion(() => true);
  const card = element(320, 220), body = element(272, 180);
  motion.capture(card, body, true);
  card.box.width = 600; body.box.height = 640;
  motion.play(card, body);
  assert.equal(card.calls.length + body.calls.length, 0);
});

test("a play without a capture does nothing, as after a load that failed", () => {
  const motion = createSizeMotion(() => false);
  const card = element(600, 220), body = element(552, 180);
  body.box.height = 640;
  motion.play(card, body);
  assert.equal(card.calls.length + body.calls.length, 0);
});

test("a second press finishes the motions still running before starting the next, never queueing", () => {
  const motion = createSizeMotion(() => false);
  const card = element(320, 220), body = element(272, 180);
  motion.capture(card, body, true);
  card.box.width = 600; body.box.height = 640;
  motion.play(card, body);
  // Pressed again mid-motion: the sizes on screen are taken, then both motions end.
  card.box.width = 480; body.box.height = 400;
  motion.capture(card, body, false);
  assert.equal(body.calls[0]!.finished, 1);
  assert.equal(card.calls[0]!.finished, 1);
  card.box.width = 320; body.box.height = 180;
  motion.play(card, body);
  assert.deepEqual(body.calls[1]!.keyframes[0], { height: "400px", overflow: "clip" });
  assert.deepEqual(card.calls[1]!.keyframes[0], { width: "480px" });
});

test("no motion when the size does not change", () => {
  assert.equal(heightKeyframes(200, 200.4), null);
  assert.equal(widthKeyframes(600, 600.3), null);
  const motion = createSizeMotion(() => false);
  const card = element(600, 220), body = element(552, 200);
  motion.capture(card, body, true);
  motion.play(card, body);
  assert.equal(card.calls.length + body.calls.length, 0);
});

test("play hands back the motions it started, and nothing when it starts none", () => {
  const motion = createSizeMotion(() => false);
  const card = element(320, 220), body = element(272, 180);
  motion.capture(card, body, true);
  card.box.width = 600; body.box.height = 640;
  assert.equal(motion.play(card, body).length, 2);
  motion.capture(card, body, false);
  assert.equal(motion.play(card, body).length, 0);
  assert.equal(createSizeMotion(() => true).play(card, body).length, 0);
});
