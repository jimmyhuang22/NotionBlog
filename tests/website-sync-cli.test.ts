import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const admin = fileURLToPath(new URL("../scripts/website-sync/cli.ts", import.meta.url));
function invoke(args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [admin, ...args], { env: { ...process.env,
      NOTION_SOURCES_JSON: "invalid-json-must-not-be-parsed", NOTION_TOKEN: "fixture-no-request",
      DATABASE_MIGRATION_URL: "invalid-must-not-be-used", SYNC_DATABASE_URL: "invalid-must-not-be-used" },
      stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { err += b; });
    child.once("error", reject); child.once("close", code => resolve({ code, out, err }));
  });
}
test("old direct sync commands stop before configuration or transport and give the guarded replacement", async () => {
  for (const mode of ["dry-run", "stage", "publish"]) {
    const result = await invoke([mode]);
    assert.equal(result.code, 2); assert.equal(result.out, "");
    assert.match(result.err, /^SYNC_HOST_REQUIRED: use npm run website:sync -- --config /);
    assert.ok(!result.err.includes("invalid-json"));
  }
});
test("administrative help is offline and rejects unknown or extra arguments before operation inputs", async () => {
  const help = await invoke(["--help"]);
  assert.equal(help.code, 0); assert.equal(help.err, "");
  assert.match(help.out, /Administrative commands: migrate/); assert.match(help.out, /maintenance window/);
  for (const args of [["migrate", "unexpected"], ["policy", "unexpected"], ["deny"], ["allow", "id", "extra"], ["unknown"]]) {
    const result = await invoke(args);
    assert.equal(result.code, 1); assert.equal(result.out, "");
    assert.match(result.err, /^Website administration failed/);
  }
});
