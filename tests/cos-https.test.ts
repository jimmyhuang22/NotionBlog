import assert from "node:assert/strict";
import test from "node:test";
import { createCosHttpsFetch } from "../src/server/database/cos-https.ts";

test("native COS GET transport rejects alternate destinations and unsigned requests before networking", async () => {
  const host="fiction-media-1250000000.cos.ap-shanghai.myqcloud.com",transport=createCosHttpsFetch(host);
  const init={method:"GET",redirect:"error",signal:new AbortController().signal,headers:{host}} satisfies RequestInit;
  for(const url of [`http://${host}/image`,`https://other.example.test/image`,`https://${host}:444/image`,`https://user:password@${host}/image`]) {
    await assert.rejects(transport(url,init),/Invalid COS transport request/);
  }
  for(const change of [{method:"PUT"},{body:"upload"},{signal:null},{redirect:"follow"},{headers:{host:"other.example.test"}}]) {
    await assert.rejects(transport(`https://${host}/image`,{...init,...change} as RequestInit),/Invalid COS transport/);
  }
  assert.throws(()=>createCosHttpsFetch("private.example.test"),/Invalid COS transport host/);
  const acceleratedHost = "fiction-media-1250000000.cos.accelerate.myqcloud.com";
  const accelerated = createCosHttpsFetch(acceleratedHost);
  await assert.rejects(accelerated(`https://${acceleratedHost}/image`, init), /Invalid COS transport signature host/);
  await assert.rejects(accelerated(`https://${host}/image`, {...init, headers: {host: acceleratedHost}}), /Invalid COS transport request/);
});
