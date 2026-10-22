import assert from "node:assert/strict";
import test from "node:test";
import { inflightNotionRead } from "../src/server/notion/inflight-reads.ts";

test("overlapping media reads share work but every subsequent check is fresh", async () => {
  let calls = 0, finish!: (value: {active: boolean}) => void;
  const load = () => {calls++; return new Promise<{active: boolean}>(resolve => {finish = resolve;});};
  const readers = Array.from({length: 13}, () => inflightNotionRead("fixture-token", "2026-03-11", "page", "owner", load));
  await Promise.resolve(); assert.equal(calls, 1); finish({active: true});
  const results = await Promise.all(readers); results[0].active = false;
  assert.ok(results.slice(1).every(value => value.active));
  const current = await inflightNotionRead("fixture-token", "2026-03-11", "page", "owner", async () => {calls++; return {active: false};});
  assert.equal(current.active, false); assert.equal(calls, 2);
});

test("failed and missing reads never survive into the next qualification", async () => {
  let calls = 0;
  const fail = () => inflightNotionRead("failure-fixture", "2026-03-11", "block", "image", async () => {calls++; throw new Error("denied");});
  await assert.rejects(fail()); await assert.rejects(fail()); assert.equal(calls, 2);
  assert.equal(await inflightNotionRead("failure-fixture", "2026-03-11", "block", "image", async () => null), null);
  assert.deepEqual(await inflightNotionRead("failure-fixture", "2026-03-11", "block", "image", async () => ({visible:true})), {visible:true});
});

test("tokens, API versions, resource kinds and identities cannot share results", async () => {
  let calls=0, release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const keys=[['a','v1','page','one'],['b','v1','page','one'],['a','v2','page','one'],['a','v1','block','one'],['a','v1','page','two']];
  const pending=keys.map(([token,version,kind,id])=>inflightNotionRead(token,version,kind,id,async()=>{calls++;await gate;return calls;}));
  await Promise.resolve();assert.equal(calls,5);release();await Promise.all(pending);
});
