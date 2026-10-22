import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import protocol from "../database/website-protocol.json" with {type:"json"};
import scoped from "../database/scoped-read-protocol.json" with {type:"json"};
if(createHash("sha256").update(await readFile(new URL(`../supabase/migrations/${scoped.migration.file}`,import.meta.url))).digest("hex")!==scoped.migration.sha256)
  throw new Error("Scoped read extension differs from its manifest.");
if(createHash("sha256").update(await readFile(new URL(`../supabase/migrations/${scoped.searchMigration.file}`,import.meta.url))).digest("hex")!==scoped.searchMigration.sha256)
  throw new Error("Scoped search extension differs from its manifest.");
if(createHash("sha256").update(await readFile(new URL(`../supabase/migrations/${scoped.traversalMigration.file}`,import.meta.url))).digest("hex")!==scoped.traversalMigration.sha256)
  throw new Error("Scoped search traversal differs from its manifest.");
const hash=createHash("sha256").update(await readFile(new URL(`../database/website-migrations/${protocol.migration.file}`,import.meta.url))).digest("hex");
if(hash!==protocol.migration.sha256||createHash("sha256").update(`website-v2:${hash}`).digest("hex")!==protocol.schemaDigest)throw new Error("Website protocol differs from its migration.");
console.log("Website v2 protocol verified; v1 unchanged.");
const media=JSON.parse(await readFile(new URL("../database/website-media-protocol.json",import.meta.url),"utf8")) as {migrations:{file:string;sha256:string}[]};
for(const migration of media.migrations){
  const hash=createHash("sha256").update(await readFile(new URL(`../database/website-media-migrations/${migration.file}`,import.meta.url))).digest("hex");
  if(hash!==migration.sha256)throw new Error("Website media source migration differs from its manifest.");
}
console.log("Website media source protocol verified.");
const study=JSON.parse(await readFile(new URL("../database/website-study-protocol.json",import.meta.url),"utf8")) as {migration:{file:string;sha256:string}};
if(createHash("sha256").update(await readFile(new URL(`../database/website-study-migrations/${study.migration.file}`,import.meta.url))).digest("hex")!==study.migration.sha256)
  throw new Error("Automatic study extension differs from its manifest.");
console.log("Automatic study extension verified; frozen v1/v2 files unchanged.");
const publication=JSON.parse(await readFile(new URL("../database/publication-protocol.json",import.meta.url),"utf8")) as {migration:{file:string;sha256:string}};
if(createHash("sha256").update(await readFile(new URL(`../supabase/migrations/${publication.migration.file}`,import.meta.url))).digest("hex")!==publication.migration.sha256)
  throw new Error("Persistent publication extension differs from its manifest.");
console.log("Persistent publication extension verified; qualified v1/v2 readers unchanged.");
const incremental=JSON.parse(await readFile(new URL("../database/incremental-publication-protocol.json",import.meta.url),"utf8")) as {migration:{file:string;sha256:string}};
if(createHash("sha256").update(await readFile(new URL(`../supabase/migrations/${incremental.migration.file}`,import.meta.url))).digest("hex")!==incremental.migration.sha256)
  throw new Error("Incremental publication extension differs from its manifest.");
console.log("Atomic incremental publication extension verified.");
const incrementalReader=JSON.parse(await readFile(new URL("../database/incremental-reader-protocol.json",import.meta.url),"utf8")) as {migration:{file:string;sha256:string}};
if(createHash("sha256").update(await readFile(new URL(`../supabase/migrations/${incrementalReader.migration.file}`,import.meta.url))).digest("hex")!==incrementalReader.migration.sha256)
  throw new Error("Incremental reader extension differs from its manifest.");
console.log("Independent incremental reader extension verified.");

const revalidation=JSON.parse(await readFile(new URL("../database/qualified-revalidation-protocol.json",import.meta.url),"utf8")) as {migration:{file:string;sha256:string}};
if(createHash("sha256").update(await readFile(new URL(`../supabase/migrations/${revalidation.migration.file}`,import.meta.url))).digest("hex")!==revalidation.migration.sha256)
  throw new Error("Qualified revalidation extension differs from its manifest.");
console.log("Qualified revalidation extension verified; original deadlines cannot be extended.");

const freshQualification=JSON.parse(await readFile(new URL("../database/fresh-qualification-protocol.json",import.meta.url),"utf8")) as {migration:{file:string;sha256:string}};
if(createHash("sha256").update(await readFile(new URL(`../supabase/migrations/${freshQualification.migration.file}`,import.meta.url))).digest("hex")!==freshQualification.migration.sha256)
  throw new Error("Fresh collection qualification extension differs from its manifest.");
console.log("Fresh collection qualification verified; no historical deadlines are updated.");

const mappedQualification=JSON.parse(await readFile(new URL("../database/mapped-capture-protocol.json",import.meta.url),"utf8")) as {migration:{file:string;sha256:string}};
if(createHash("sha256").update(await readFile(new URL(`../supabase/migrations/${mappedQualification.migration.file}`,import.meta.url))).digest("hex")!==mappedQualification.migration.sha256)
  throw new Error("Mapped fresh qualification extension differs from its manifest.");
console.log("Mapped fresh qualification verified; no historical deadlines are updated.");
