import test from "node:test";
import assert from "node:assert/strict";
import { assertMatchingDatabaseTargets } from "../scripts/media-thumbnails/targets.ts";

test("thumbnail destinations allow independent credentials for the same local or direct database", () => {
  assert.doesNotThrow(() => assertMatchingDatabaseTargets("postgresql://reader:example@localhost:5432/example", "postgres://writer:different@localhost/example"));
  assert.doesNotThrow(() => assertMatchingDatabaseTargets("postgres://reader:example@db.projectexample.supabase.co:5432/postgres", "postgres://writer:different@db.projectexample.supabase.co:5432/postgres"));
});

test("shared Supabase poolers must match the project suffix as well as host, port and database", () => {
  const url = (role:string, project:string) => `postgres://${role}.${project}:example@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`;
  assert.doesNotThrow(() => assertMatchingDatabaseTargets(url("reader", "abcdefghijklmnopqrst"), url("writer", "abcdefghijklmnopqrst")));
  assert.throws(() => assertMatchingDatabaseTargets(url("reader", "abcdefghijklmnopqrst"), url("writer", "bcdefghijklmnopqrstu")), /targets differ/);
  assert.throws(() => assertMatchingDatabaseTargets(url("reader", "abcdefghijklmnopqrst"), "postgres://writer:example@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"));
  for (const host of ["AWS-0-AP-SOUTHEAST-1.POOLER.SUPABASE.COM", "aws-0-ap-southeast-1.pooler.supabase.com.", "aws-0-ap-southeast-1%2Epooler%2Esupabase%2Ecom"]) {
    const pooled = (role:string, project:string) => `postgres://${role}.${project}:example@${host}:5432/postgres`;
    assert.doesNotThrow(() => assertMatchingDatabaseTargets(url("reader", "abcdefghijklmnopqrst"), pooled("writer", "abcdefghijklmnopqrst")));
    assert.throws(() => assertMatchingDatabaseTargets(pooled("reader", "abcdefghijklmnopqrst"), pooled("writer", "bcdefghijklmnopqrstu")), /targets differ/);
  }
});

test("mismatched and malformed thumbnail destinations are rejected without credential details", () => {
  const reader = "postgres://reader:example@localhost:5432/example";
  for (const writer of [undefined, "", "https://writer:do-not-print@localhost/example", "postgres://writer:do-not-print@localhost:5433/example",
    "postgres://writer:do-not-print@localhost:5432/other", "postgres://writer:do-not-print@other.example.test:5432/example",
    "postgres://writer:do-not-print@localhost:5432/example?sslmode=disable", "postgres://writer:do-not-print@localhost:5432/example#fragment",
    "postgres://writer@localhost:5432/example", "postgres://writer:do-not-print@localhost:5432/", "postgres://writer:do-not-print@localhost:5432/example%0a"]) {
    assert.throws(() => assertMatchingDatabaseTargets(reader, writer), error => error instanceof Error && !error.message.includes("do-not-print"));
  }
});
