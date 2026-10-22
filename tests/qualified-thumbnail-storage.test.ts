import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

test("qualified runtime keeps converted originals in Supabase and reads variants from COS",async()=>{
 const result=await promisify(execFile)(process.execPath,["--conditions=react-server",fileURLToPath(new URL("./helpers/qualified-thumbnail-storage.ts",import.meta.url))],{timeout:90000,maxBuffer:65536});
 assert.deepEqual(JSON.parse(result.stdout),{originals:1,variants:2,cosFailureDidNotFallBack:true,writesDenied:true});
});
