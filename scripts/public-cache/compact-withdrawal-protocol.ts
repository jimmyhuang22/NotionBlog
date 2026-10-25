import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export const COMPACT_WITHDRAWAL_PROTOCOL_SHA256 = "f139beab3153a08ae1e1ae4c079699a7f42d4c76ae344c191592c28d1f992e64";
export const COMPACT_WITHDRAWAL_SIGNATURES = ["nb_cache_api.plan_withdraw_compact(text)", "nb_cache_api.withdraw_compact(uuid,jsonb)"] as const;
export interface CompactWithdrawalFunctionPin {
  signature: string; sourceSha256: string; language: "sql" | "plpgsql"; volatility: "s" | "v";
  securityDefiner: true; searchPath: string[]; returnType: "jsonb" | "boolean" | "void"; ownerTables: string[];
  acl: unknown[]; roleExecute: Record<string, boolean>;
}
export interface CompactWithdrawalProtocol {
  format: "notionblog-compact-withdrawal-protocol"; version: 1;
  migration: { file: string; sha256: string };
  recipe: { prefix: string; suffix: string; bodySha256: string };
  functions: CompactWithdrawalFunctionPin[];
  dependencies: CompactWithdrawalFunctionPin[];
  baseSources: { file: string; sha256: string; schemaDigest?: string }[];
}
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (): never => { throw Error("COMPACT_WITHDRAWAL_PROTOCOL_INVALID"); };

/** Public, byte-pinned metadata only. No project configuration or caller-selected SQL. */
export async function loadCompactWithdrawalProtocol(): Promise<CompactWithdrawalProtocol> {
  try {
    const source = await readFile(new URL("../../database/compact-withdrawal-protocol.json", import.meta.url), "utf8");
    if (hash(source) !== COMPACT_WITHDRAWAL_PROTOCOL_SHA256) fail();
    const value = JSON.parse(source) as CompactWithdrawalProtocol;
    if (value.format !== "notionblog-compact-withdrawal-protocol" || value.version !== 1 ||
        !/^\d{14}_compact_withdrawal\.sql$/.test(value.migration.file) || !digest(value.migration.sha256) ||
        !digest(value.recipe.bodySha256) || value.recipe.suffix !== "COMMIT;\n" || !value.recipe.prefix.endsWith("BEGIN;\n") ||
        value.functions.length !== 2 || value.functions.some((fn, index) => fn.signature !== COMPACT_WITHDRAWAL_SIGNATURES[index] ||
          !digest(fn.sourceSha256) || fn.volatility !== (index === 0 ? "s" : "v")) || value.dependencies.length !== 5 ||
        value.dependencies.map(fn => fn.signature).join("|") !== "nb_cache_api.complete_event(uuid,bigint)|nb_cache_api.read_event(uuid)|nb_cache_api.read_withdraw(uuid)|nb_v2.record_eligible(uuid,text)|nb_v2_api.set_denied(text,boolean)" ||
        value.baseSources.length !== 2) fail();
    for (const base of value.baseSources) {
      if (!/^(?:supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql|database\/website-migrations\/001_website\.sql)$/.test(base.file) ||
          !digest(base.sha256) || base.schemaDigest !== undefined && !digest(base.schemaDigest) ||
          hash(await readFile(new URL("../../" + base.file, import.meta.url), "utf8")) !== base.sha256) fail();
    }
    return value;
  } catch { return fail(); }
}

/** Exact single-purpose transaction body; the original migration stays byte-pinned. */
export async function loadCompactWithdrawalRecipe() {
  const protocol = await loadCompactWithdrawalProtocol();
  try {
    const source = await readFile(new URL(`../../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8");
    const { prefix, suffix, bodySha256 } = protocol.recipe;
    if (hash(source) !== protocol.migration.sha256 || !source.startsWith(prefix) || !source.endsWith(suffix) ||
        source.split(prefix).length !== 2 || source.split(suffix).length !== 2) fail();
    const body = source.slice(prefix.length, -suffix.length);
    if (hash(body) !== bodySha256) fail();
    return { body, migrationSha256: protocol.migration.sha256, recipeSha256: bodySha256 };
  } catch { return fail(); }
}
