import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
test('qualified v2 database-thumbnail route reads no Notion and blocks withdrawal before and during object transfer',async()=>{
 const result=await promisify(execFile)(process.execPath,['--conditions=react-server',fileURLToPath(new URL('./helpers/qualified-database-thumbnail-route.ts',import.meta.url))],{timeout:60000,maxBuffer:65536});
 assert.deepEqual(JSON.parse(result.stdout),{sourceRequests:0,objectRequests:2,cacheHitQualified:true,centralWithdrawalBlocked:true,postReadWithdrawalBlocked:true});
});


test('qualified 1600 course-cover route uses database/COS only and blocks withdrawals',async()=>{
 const result=await promisify(execFile)(process.execPath,['--conditions=react-server',fileURLToPath(new URL('./helpers/qualified-course-thumbnail-route.ts',import.meta.url))],{timeout:60000,maxBuffer:65536});
 assert.deepEqual(JSON.parse(result.stdout),{sourceRequests:0,objectRequests:2,cacheHitQualified:true,centralWithdrawalBlocked:true,postReadWithdrawalBlocked:true});
});


test('qualified 1600 body-image route uses the same cache and fresh withdrawal guards',async()=>{
 const result=await promisify(execFile)(process.execPath,['--conditions=react-server',fileURLToPath(new URL('./helpers/qualified-course-thumbnail-route.ts',import.meta.url)),'body'],{timeout:60000,maxBuffer:65536});
 assert.deepEqual(JSON.parse(result.stdout),{sourceRequests:0,objectRequests:2,cacheHitQualified:true,centralWithdrawalBlocked:true,postReadWithdrawalBlocked:true});
});
