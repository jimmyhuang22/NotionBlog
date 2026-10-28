import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute=promisify(execFile);
const nextConfig=new URL('../next.config.ts',import.meta.url).href;

// S13-6 (2026-10-28): a page seen in the same tab comes back at once for five minutes,
// with or without the public content cache.
test('production keeps pages for five minutes in the browser in both cache modes',async()=>{
  for(const cache of [undefined,'tagged-v1']){
    const env={VERCEL:'1',VERCEL_ENV:'production',CONTENT_PROVIDER:'database',DATABASE_READER_URL:'synthetic-private',...(cache?{PUBLIC_CONTENT_CACHE:cache}:{})};
    const script=`for(const key of ['VERCEL','VERCEL_ENV','VERCEL_TARGET_ENV','GITHUB_ACTIONS','NOTIONBLOG_DEVELOPMENT_MODE','PUBLIC_CONTENT_CACHE'])delete process.env[key];Object.assign(process.env,${JSON.stringify(env)});const {default:config}=await import(${JSON.stringify(nextConfig)});const result=config('phase-production-build');console.log(JSON.stringify({staleTimes:result.experimental?.staleTimes,expireTime:result.expireTime??null}));`;
    const result=JSON.parse((await execute(process.execPath,['--input-type=module','-e',script])).stdout.trim());
    if(cache){
      assert.deepEqual(result.staleTimes,{dynamic:300,static:300});
      assert.equal(result.expireTime,86400);
    }else{
      assert.deepEqual(result.staleTimes,{dynamic:300});
      assert.equal(result.expireTime,null);
    }
  }
});
