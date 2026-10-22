import test from "node:test";
import assert from "node:assert/strict";
import { createCoverAuthSession } from "../scripts/social-media/auth.ts";

const userId="00000000-0000-0000-0000-000000000001",metadata={notionblog_social_storage_role:"writer"};
const env={SOCIAL_MEDIA_STORAGE_URL:"https://example.invalid/storage/v1",SOCIAL_MEDIA_STORAGE_API_KEY:"sb_publishable_example",
  SOCIAL_MEDIA_STORAGE_WRITER_EMAIL:"writer@example.invalid",SOCIAL_MEDIA_STORAGE_WRITER_PASSWORD:"example-password",SOCIAL_MEDIA_STORAGE_WRITER_USER_ID:userId};
const claims=()=>({iss:"https://example.invalid/auth/v1",aud:"authenticated",sub:userId,role:"authenticated",exp:Date.now()/1000+3600,app_metadata:metadata});
const jwt=(body=claims())=>[Buffer.from(JSON.stringify({alg:"HS256"})).toString("base64url"),Buffer.from(JSON.stringify(body)).toString("base64url"),"example-signature"].join(".");
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
test("separate social password session coalesces login, validates current user and signs out locally once",async()=>{
  const paths:string[]=[];const s=createCoverAuthSession(env,"writer",async(input,init)=>{
    const url=new URL(String(input));paths.push(url.pathname+url.search);assert.equal(init!.redirect,"error");assert.equal(init!.cache,"no-store");
    if(url.pathname.endsWith("/token"))return json({token_type:"bearer",access_token:jwt(),refresh_token:"must-not-persist"});
    if(url.pathname.endsWith("/user"))return json({id:userId,role:"authenticated",app_metadata:metadata});
    assert.equal(url.search,"?scope=local");assert.equal(init!.method,"POST");return new Response(null,{status:204});
  });
  assert.equal(await s.token(),await s.token());assert.equal(paths.length,2);await Promise.all([s.close(),s.close()]);assert.equal(paths.length,3);
  await assert.rejects(s.token(),/COVER_AUTH_CLOSED/);
});
test("JWT metadata alone is insufficient and failed current-user validation never retries in the same batch",async()=>{
  let requests=0;const s=createCoverAuthSession(env,"writer",async(input)=>{
    requests++;if(String(input).includes("/token?"))return json({token_type:"bearer",access_token:jwt()});
    if(String(input).endsWith("/user"))return json({id:userId,role:"authenticated",user_metadata:metadata,app_metadata:{}});
    return new Response(null,{status:204});
  });
  await assert.rejects(s.token(),/COVER_AUTH_FAILED/);await assert.rejects(s.token(),/COVER_AUTH_FAILED/);assert.equal(requests,2);await s.close();assert.equal(requests,3);
});
test("foreign, mixed, reader-only, broad or short-lived token claims fail before object use",async()=>{
  for(const mutation of [
    (c:ReturnType<typeof claims>)=>{c.sub="00000000-0000-0000-0000-000000000002";},
    (c:ReturnType<typeof claims>)=>{c.app_metadata={...metadata,notionblog_storage_role:"writer"} as typeof metadata;},
    (c:ReturnType<typeof claims>)=>{c.app_metadata={notionblog_social_storage_role:"reader"};},
    (c:ReturnType<typeof claims>)=>{c.role="service_role";},
    (c:ReturnType<typeof claims>)=>{c.exp=Date.now()/1000+60;},
  ]){
    let requests=0;const c=claims();mutation(c);const s=createCoverAuthSession(env,"writer",async()=>{requests++;return json({token_type:"bearer",access_token:jwt(c)});});
    await assert.rejects(s.token(),/COVER_AUTH_FAILED/);await s.close();assert.equal(requests,1);
  }
});
test("invalid configuration and broad API key cannot reach Auth",()=>{
  for(const change of [{SOCIAL_MEDIA_STORAGE_WRITER_PASSWORD:""},{SOCIAL_MEDIA_STORAGE_API_KEY:"sb_secret_example"},{SOCIAL_MEDIA_STORAGE_URL:"http://example.invalid/storage/v1"}])
    assert.throws(()=>createCoverAuthSession({...env,...change},"writer",async()=>{throw Error("unexpected Auth request");}),/COVER_AUTH_CONFIG_INVALID/);
});
test("cancellation bounds an ignored network signal and drains pending authentication before close",async()=>{
  const controller=new AbortController(),s=createCoverAuthSession(env,"writer",async()=>new Promise<Response>(()=>{}),controller.signal);
  const token=s.token();controller.abort();await assert.rejects(token,/COVER_AUTH_FAILED/);await s.close();
});
test("oversized Auth response is rejected without persisting or returning refresh credentials",async()=>{
  const s=createCoverAuthSession(env,"writer",async()=>new Response("secret",{headers:{"content-length":"65537"}}));
  await assert.rejects(s.token(),/COVER_AUTH_FAILED/);await s.close();
});
test("close drains an in-flight login but never hands its late token to an object request",async()=>{
  let release:(response:Response)=>void=()=>{};let userChecks=0,logouts=0;
  const s=createCoverAuthSession(env,"writer",async(input)=>{
    if(String(input).includes("/token?"))return new Promise<Response>(resolve=>{release=resolve;});
    if(String(input).endsWith("/user")){userChecks++;return json({id:userId,role:"authenticated",app_metadata:metadata});}
    logouts++;return new Response(null,{status:204});
  });
  const token=s.token(),rejection=assert.rejects(token,/COVER_AUTH_CLOSED/),closed=s.close();
  release(json({token_type:"bearer",access_token:jwt()}));await rejection;await closed;assert.equal(userChecks,1);assert.equal(logouts,1);
});
