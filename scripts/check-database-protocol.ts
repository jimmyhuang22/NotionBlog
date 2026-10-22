import { readFile,writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { configDigest } from "../src/server/database/validation.ts";

const target=new URL("../database/protocol.json",import.meta.url);
const previous=JSON.parse(await readFile(target,"utf8")) as {protocol:string;schemaDigest:string;migrations:{version:string;file:string;sha256:string}[]};
const migrations=await Promise.all(previous.migrations.map(async m=>({...m,sha256:createHash("sha256").update(await readFile(new URL(`../database/migrations/${m.file}`,import.meta.url))).digest("hex")})));
const schemaDigest=configDigest(migrations);
if(process.argv.includes("--write")) {
  await writeFile(target,JSON.stringify({...previous,schemaDigest,migrations},null,2)+"\n");
  console.log("Database protocol manifest updated.");
} else {
  if(previous.schemaDigest!==schemaDigest||previous.migrations.some((m,i)=>m.sha256!==migrations[i].sha256)) {
    console.error("Database protocol digest differs from migrations.");process.exitCode=1;
  } else console.log("Database protocol digests verified.");
}
const readerTarget=new URL("../database/reader-protocol.json",import.meta.url);
const reader=JSON.parse(await readFile(readerTarget,"utf8")) as {capability:string;migrations:{version:string;file:string;sha256:string}[]};
const readerMigrations=await Promise.all(reader.migrations.map(async m=>({...m,sha256:createHash("sha256").update(await readFile(new URL(`../database/reader-migrations/${m.file}`,import.meta.url))).digest("hex")})));
if(process.argv.includes("--write")) {
  await writeFile(readerTarget,JSON.stringify({...reader,migrations:readerMigrations},null,2)+"\n");
  console.log("Website reader manifest updated.");
} else if(reader.migrations.some((m,i)=>m.sha256!==readerMigrations[i].sha256)) {
  console.error("Website reader digest differs from migrations.");process.exitCode=1;
} else console.log("Website reader digests verified.");
const mediaTarget=new URL("../database/media-protocol.json",import.meta.url);
const media=JSON.parse(await readFile(mediaTarget,"utf8")) as {capability:string;migrations:{version:string;file:string;sha256:string}[]};
const mediaMigrations=await Promise.all(media.migrations.map(async m=>({...m,sha256:createHash("sha256").update(await readFile(new URL(`../database/media-migrations/${m.file}`,import.meta.url))).digest("hex")})));
if(process.argv.includes("--write")) {
  await writeFile(mediaTarget,JSON.stringify({...media,migrations:mediaMigrations},null,2)+"\n");
  console.log("Media source manifest updated.");
} else if(media.migrations.some((m,i)=>m.sha256!==mediaMigrations[i].sha256)) {
  console.error("Media source digest differs from migrations.");process.exitCode=1;
} else console.log("Media source digests verified.");
