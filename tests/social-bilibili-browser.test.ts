import test from "node:test";
import assert from "node:assert/strict";
import { captureBilibiliDirectory, captureBilibiliSeasonLinks } from "../scripts/social-sync/browser/bilibili-directory.js";

const uid="10001",id=(n:number)=>`BV${String(n).padStart(10,"0")}`,job={id:"00000000-0000-4000-8000-000000000001",accountId:uid,expiresAt:new Date(Date.now()+300000).toISOString()};
test("browser directory traversal waits for changed cards and closes only its own tab",async()=>{
  let page=1,stale=false,polls=0,closed=0,time=Date.now();const origin=`https://space.bilibili.com/${uid}/upload/video`;
  const api={tabs:{create:async(o:unknown)=>{assert.deepEqual(o,{url:origin,active:false});return{id:7};},get:async()=>({status:"complete",url:origin}),remove:async(n:number)=>{assert.equal(n,7);closed++;}},scripting:{executeScript:async(o:{func:Function;target:{frameIds:number[]}})=>{
    assert.deepEqual(o.target.frameIds,[0]);if(o.func.name==="nextBilibiliDirectoryPage"){page++;stale=true;return[{frameId:0,result:{clicked:true}}];}
    polls++;const p=stale?page-1:page;stale=false;return[{frameId:0,result:{version:1,accountId:uid,observedAt:new Date().toISOString(),page:p,pageSize:42,pages:3,total:109,
      ids:Array.from({length:Math.min(42,109-(p-1)*42)},(_,j)=>id((p-1)*42+j+1))}}];}}};
  const result=await captureBilibiliDirectory(api,job,{now:()=>time,sleep:async()=>{time+=1000;}});
  assert.deepEqual(result.map(p=>p.ids.length),[42,42,25]);assert.equal(new Set(result.flatMap(p=>p.ids)).size,109);assert.equal(polls,5);assert.equal(closed,1);
});
test("browser authentication redirect closes the owned tab and returns no directory",async()=>{
  let closed=0;const api={tabs:{create:async()=>({id:7}),get:async()=>({status:"complete",url:"https://passport.bilibili.com/login"}),remove:async()=>{closed++;}},scripting:{executeScript:async()=>{throw Error("must not inspect login");}}};
  await assert.rejects(captureBilibiliDirectory(api,job),/SOURCE_BLOCKED/);assert.equal(closed,1);
});
test("season-link capture visits the fixed canonical page and does not return fake proof on a redirect",async()=>{
  const j={...job,key:"a".repeat(64),collectionId:"200",representativeId:id(1)},url=`https://space.bilibili.com/${uid}/lists/200?type=season`;let closed=0,blocked=false;
  const api={tabs:{create:async(o:unknown)=>{assert.deepEqual(o,{url,active:false});return{id:7};},get:async()=>({status:"complete",url:blocked?"https://passport.bilibili.com/login":url}),remove:async()=>{closed++;}},scripting:{executeScript:async()=>[{frameId:0,result:{id:j.id,key:j.key,url,checkedAt:new Date().toISOString()}}]}};
  const proof=await captureBilibiliSeasonLinks(api,[j]);assert.equal(proof.length,1);assert.equal(proof[0].url,url);
  blocked=true;await assert.rejects(captureBilibiliSeasonLinks(api,[j]),/SOURCE_BLOCKED/);assert.equal(closed,2);
});
