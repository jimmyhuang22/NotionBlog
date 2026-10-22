import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hostFixture } from "./helpers/incremental-host.ts";
import { openFullBaselineDatabase, openIncrementalDatabase } from "../src/server/database/incremental-connection.ts";

test("the first full binding needs installed restricted capabilities without an accepted pointer", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  await f.db.exec("UPDATE nb_v2.state SET current_run=NULL; UPDATE nb_publication.state SET run_id=NULL");
  await assert.rejects(openIncrementalDatabase({ ...f.options.database, configDigest: f.digest }, { open: f.open }));
  const binding = await openFullBaselineDatabase({ ...f.options.database, configDigest: f.digest }, { open: f.open });
  try {
    await assert.rejects(binding.fullPublisher.begin(randomUUID(), "f".repeat(64)), { code: "DATABASE_BINDING_SCOPE_MISMATCH" });
    const lease = await binding.fullPublisher.begin(randomUUID(), f.digest);
    await binding.fullPublisher.stage(lease, f.artifact.collection.records);
    await binding.fullPublisher.promote(lease, { records: 3, media: 0, complete: true });
  } finally { await binding.close(); }
  const normal = await openIncrementalDatabase({ ...f.options.database, configDigest: f.digest }, { open: f.open });
  try { assert.equal((await normal.publisher.state()).configDigest, f.digest); } finally { await normal.close(); }
  assert.equal(f.counts.pools, f.counts.closed);
});
test("full startup checks full-only grants, login isolation and cleanup before allocating any sources", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const cases = [
    ["missing full reader", "REVOKE EXECUTE ON FUNCTION nb_publication_api.read_snapshot(text[],boolean) FROM nb_reader", "GRANT EXECUTE ON FUNCTION nb_publication_api.read_snapshot(text[],boolean) TO nb_reader"],
    ["missing full writer", "REVOKE EXECUTE ON FUNCTION nb_publication_api.promote_run(uuid,bigint,integer,integer,boolean,integer) FROM nb_writer", "GRANT EXECUTE ON FUNCTION nb_publication_api.promote_run(uuid,bigint,integer,integer,boolean,integer) TO nb_writer"],
    ["crossed login", "GRANT nb_writer TO fixture_reader", "REVOKE nb_writer FROM fixture_reader"],
  ];
  for (const [name, grant, restore] of cases) await t.test(name, async () => {
    await f.db.exec(grant);
    try { await assert.rejects(openFullBaselineDatabase({ ...f.options.database, configDigest: f.digest }, { open: f.open }), { code: "DATABASE_BINDING_ROLE_INVALID" }); }
    finally { await f.db.exec(restore); }
    assert.equal(f.counts.pools, f.counts.closed);
  });
});
