import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createHttpSourcePacer} from "../scripts/social-sync/xiaohongshu-http-pacing.ts";

test("HTTP start spacing survives batch boundaries and accounts for intervening upload time",async()=>{
  let at=100;const waits:number[]=[];
  const pace=createHttpSourcePacer({now:()=>at,sleep:async ms=>{waits.push(ms);at+=ms;}});
  await pace();at+=2000;await pace();assert.deepEqual(waits,[3000]);
  at+=8000;await pace();assert.deepEqual(waits,[3000]);
  at+=1000;await pace();assert.deepEqual(waits,[3000,4000]);
});
test("cancelling during pacing prevents a source start and does not reset the last-start boundary",async()=>{
  let at=0;const controller=new AbortController();let aborted=false;
  const pace=createHttpSourcePacer({now:()=>at,sleep:async ms=>{if(!aborted){aborted=true;controller.abort();}else at+=ms;}});
  await pace();at=1000;await assert.rejects(pace(controller.signal),{code:"CANCELLED"});
  await pace();assert.equal(at,5000);
  await assert.rejects(pace(controller.signal),{code:"CANCELLED"});
});
test("platform verification is a fatal session pause, never a note-specific fallback or followed redirect",()=>{
  const path=fileURLToPath(new URL('../scripts/social-sync/python/xiaohongshu_http.py',import.meta.url));
  const code="import importlib.util,sys\ns=importlib.util.spec_from_file_location('probe',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nu='https://www.xiaohongshu.com/explore/'+'0'*23+'2'\nassert m.redirect_code('/website-login/captcha?verifyUuid=example',u)=='SOURCE_VERIFICATION_REQUIRED'\nassert m.redirect_code('https://example.invalid/website-login/captcha',u)=='SOURCE_REDIRECT'\nassert m.redirect_code('https://www.xiaohongshu.com:444/website-login/captcha',u)=='SOURCE_REDIRECT'\n";
  const r=spawnSync('python3',['-I','-B','-c',code,path],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
