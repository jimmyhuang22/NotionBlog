import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { credentialAssignment, databaseCredential } from "../scripts/privacy/credential-rules.mjs";

const random = (bytes = 20) => randomBytes(bytes).toString("hex");
const env = (key: string, value: string, quote = "") => [key, `${quote}${value}${quote}`].join("=");
const dsn = (pairs: [string, string][], separator = " ") => pairs.map(([key, value]) => env(key, value)).join(separator);

test("sensitive exact names and prefixed names are case insensitive", () => {
  for (const name of ["TOKEN", "PASSWORD", "NPSSO", "SECRET", "API_KEY", "PRIVATE_KEY", "SECRET_KEY", "psn_npsso", "token", "password", "service_token"]) {
    const value = random();
    for (const body of [env(name, value), JSON.stringify({ [name]: value })]) assert.equal(credentialAssignment(body), true);
  }
  assert.equal(credentialAssignment(env("NOT_TOKENIZED", random(), '"')), false);
  assert.equal(credentialAssignment(env("$TOKEN", random(), '"')), false);
});

test("literal passwords include punctuation and escaped quotes without changing the length threshold", () => {
  for (const value of [`${random()}!@#$%^&*()`, "!@#$%^&*(){}[]:;?", `${random()}\\\"${random()}`]) {
    assert.equal(credentialAssignment(env("SERVICE_PASSWORD", value, '"')), true);
  }
  assert.equal(credentialAssignment(env("PASSWORD", `${random()}!@`)), true);
  assert.equal(credentialAssignment(env("PASSWORD", random(5), '"')), false);
  assert.equal(credentialAssignment(env("PASSWORD", random(6), '"')), true);
  assert.equal(credentialAssignment(env("PASSWORD", `{${random()}}`, "'")), true);
  assert.equal(credentialAssignment(env("PASSWORD", `$${random()}!`, "'")), true);
  assert.equal(credentialAssignment(env("PASSWORD", `<${random()}>`, "'")), true);
  for (const value of [`${random()}(x)`, `abc;${random()}`, `abc'${random()}`, `${random()}=>`, `(${random()})`, `{${random()}}`, `;${random()}`]) assert.equal(credentialAssignment(env("PASSWORD", value), "cloud.env.example"), true);
  assert.equal(credentialAssignment(["SERVICE_PASSWORD", random()].join(": "), "settings.yml"), true);
  const pattern = env("xsec_token", "[A-Za-z0-9_=-]{16,255}");
  assert.equal(credentialAssignment(`IF outbound !~ '${pattern}' THEN`, "migration.sql"), false);
  assert.equal(credentialAssignment(env("PASSWORD", `[${random()}]`), "cloud.env.example"), true);
  assert.equal(credentialAssignment(`INSERT INTO data VALUES ('${env("TOKEN", random())}');`, "migration.sql"), true);
  for (let code = 33; code <= 126; code++) {
    const value = `${String.fromCharCode(code)}${random()}!`;
    assert.equal(credentialAssignment(env("PASSWORD", value), "cloud.env.example"), true, `dotenv printable prefix ${code}`);
    assert.equal(credentialAssignment(["PASSWORD", value].join(": "), "settings.yml"), true, `YAML printable prefix ${code}`);
  }
});

test("whole placeholders and whole dynamic references remain valid without prefix bypasses", () => {
  for (const value of ["", "<SERVICE_PASSWORD>", "$SERVICE_PASSWORD", "${SERVICE_PASSWORD}", "example", "redacted"]) assert.equal(credentialAssignment(env("SERVICE_PASSWORD", value, '"')), false);
  assert.equal(credentialAssignment("const SERVICE_PASSWORD = process.env.SERVICE_PASSWORD;"), false);
  assert.equal(credentialAssignment("const TOKEN = existingTokenReference;"), false);
  for (const prefix of ["fixture", "example", "synthetic", "dummy-", "your-", "redacted", "${TOKEN}"]) assert.equal(credentialAssignment(env("SERVICE_PASSWORD", `${prefix}${random()}`, '"')), true);
  assert.equal(credentialAssignment(env("token", "offline-fixture", '"'), "scripts/notion-sync/demo.ts"), false);
  assert.equal(credentialAssignment(env("token", "offline-fixture", '"'), "src/runtime.ts"), true);
  assert.equal(credentialAssignment(env("token", `offline-fixture${random()}`, '"'), "scripts/notion-sync/demo.ts"), true);
  assert.equal(credentialAssignment(env("token", "${url.searchParams.get('token')}"), "src/runtime.ts"), false);
  assert.equal(credentialAssignment(env("token", `${random()}`), "cloud.env.example"), true);
});

test("remote PostgreSQL URLs and keyword DSNs reject any nonempty literal password", () => {
  const host = `db-${random(4)}.company.dev`, password = random(2);
  for (const body of [
    `postgresql://reader:${password}@${host}/db`,
    dsn([["host", host], ["user", "reader"], ["password", password], ["dbname", "db"]]),
    dsn([["dbname", "db"], ["password", `'${password}\\' ${random()}'`], ["host", host]]),
    dsn([["host", host], ["password", `${password}\\ ${random()}`], ["dbname", "db"]]),
    dsn([["host", `localhost,${host}`], ["password", password], ["dbname", "db"]]),
    dsn([["host", "localhost"], ["hostaddr", "192.0.2.10"], ["password", password], ["dbname", "db"]]),
    dsn([["user", "reader"], ["password", password], ["dbname", "db"]]),
    dsn([["host", host], ["password", `'${password}`]]),
    env("DATABASE_URL", dsn([["host", host], ["password", password], ["dbname", "db"]]), '"'),
    env("DATABASE_URL", env("password", password), '"'),
    env("DATABASE_URL", dsn([["host", host], ["user", "reader"], ["password ", ` '${password}'`], ["dbname", "db"]]), '"'),
    dsn([["host", host], ["password", password], ["dbname", "db"]], "\n"),
    dsn([["host", host], ["password", `"${password}"`], ["dbname", "db"]]),
  ]) assert.equal(databaseCredential(body), true);
  assert.equal(credentialAssignment(env("DATABASE_URL", `unrecognized-${random()}`, '"')), true);
});

test("explicit local and reserved example endpoints remain valid, with every host validated", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "db.example.test", "db.example.org"]) {
    assert.equal(databaseCredential(`postgresql://reader:${random()}@${host}/db`), false);
    assert.equal(databaseCredential(dsn([["host", host], ["password", `'${random()}'`], ["dbname", "db"]])), false);
  }
  assert.equal(databaseCredential(dsn([["host", "/tmp/pg-probe"], ["password", random()], ["dbname", "db"]])), false);
  assert.equal(databaseCredential(dsn([["host", "localhost,127.0.0.1"], ["password", random()], ["dbname", "db"]])), false);
  assert.equal(databaseCredential(dsn([["host", "''"], ["password", random()], ["dbname", "db"]])), true);
  assert.equal(databaseCredential(env("password", random())), false);
  assert.equal(databaseCredential(dsn([["host", "db.company.dev"], ["password", "'<PASSWORD>'"], ["dbname", "db"]])), false);
  assert.equal(databaseCredential(dsn([["host", "db.company.dev"], ["password", "'$PASSWORD'"], ["dbname", "db"]])), false);
  assert.equal(databaseCredential("postgresql://reader:fictional!pass@db.company.dev/db", "tests/legacy-db.ts"), false);
  assert.equal(databaseCredential("postgresql://reader:fictional!pass@db.company.dev/db", "src/runtime.ts"), true);
});
