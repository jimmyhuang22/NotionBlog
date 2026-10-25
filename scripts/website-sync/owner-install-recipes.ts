import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import isolation from "../../database/incremental-reader-isolation.json" with { type: "json" };
import recovery from "../../database/incremental-withdrawal-recovery.json" with { type: "json" };

export const OWNER_INSTALL_RECIPE_DIGEST = "13b1e8df07650bdb0f8c68b78f2c9e13f591be116fd3a4612bb66c1b87aa4a3f";
export type RecipeName = "reader-isolation" | "withdrawal-recovery";
export interface OwnerInstallReceipt { schemaDigest: string; recipeDigest: string; outcome: "installed" | "verified-existing" }
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** Two fixed recipes, exact boundaries and independent body hashes; no general SQL rewriting. */
export async function loadOwnerInstallRecipe(name: RecipeName) {
  const source = await readFile(new URL("../../database/incremental-owner-install-recipes.json", import.meta.url), "utf8");
  if (sha(source) !== OWNER_INSTALL_RECIPE_DIGEST) throw Error("OWNER_INSTALL_RECIPE_DIFFERENT");
  const entry = JSON.parse(source).recipes[name] as { migration: string; schemaDigest: string; prefix: string; suffix: string; removedStatement: string | null; bodyDigest: string };
  const manifest = name === "reader-isolation" ? isolation : recovery;
  if (entry.migration !== manifest.migration.file || entry.schemaDigest !== manifest.migration.sha256) throw Error("OWNER_INSTALL_SCHEMA_DIFFERENT");
  const original = await readFile(new URL(`../../supabase/migrations/${manifest.migration.file}`, import.meta.url), "utf8");
  if (sha(original) !== entry.schemaDigest || !original.startsWith(entry.prefix) || !original.endsWith(entry.suffix) || original.split(entry.prefix).length !== 2 || original.split(entry.suffix).length !== 2) throw Error("OWNER_INSTALL_SCHEMA_DIFFERENT");
  let body = original.slice(entry.prefix.length, -entry.suffix.length);
  if (entry.removedStatement !== null) {
    if (body.split(entry.removedStatement).length !== 2) throw Error("OWNER_INSTALL_BODY_DIFFERENT");
    const index = body.indexOf(entry.removedStatement);
    body = body.slice(0, index) + body.slice(index + entry.removedStatement.length);
  }
  if (sha(body) !== entry.bodyDigest) throw Error("OWNER_INSTALL_BODY_DIFFERENT");
  return { body, schemaDigest: entry.schemaDigest, recipeDigest: OWNER_INSTALL_RECIPE_DIGEST };
}
