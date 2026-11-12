import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyAccessJwt, previewAccessAllowed, loadAccessConfig, type AccessConfig } from "../scripts/self-hosted/access-jwt.ts";
const { publicKey, privateKey } = generateKeyPairSync("rsa",{modulusLength:2048});
const now=Math.floor(Date.now()/1000);
const config: AccessConfig = {previewHost:"preview.example.test",issuer:"example.cloudflareaccess.com",audience:"a".repeat(64),expiresAt:now+3600,keys:[{...publicKey.export({format:"jwk"}),kid:"fixture",alg:"RS256"}]};
config.issuer="https://"+config.issuer;
const base={iss:config.issuer,aud:[config.audience],iat:now-1,exp:now+300,type:"app"};
function token(claims:object=base, header:object={alg:"RS256",kid:"fixture"}) {
  const body=[header,claims].map(x=>Buffer.from(JSON.stringify(x)).toString("base64url")).join(".");
  return body+"."+sign("RSA-SHA256",Buffer.from(body),privateKey).toString("base64url");
}
test("Access validates RSA signature, pinned issuer/audience/type, expiry and JWKS lifetime",()=>{
  assert.equal(verifyAccessJwt(token(),config,now),true);
  for(const patch of [{iss:"https://other.cloudflareaccess.com"},{aud:["b".repeat(64)]},{type:"org"},{exp:now},{iat:now+60},{nbf:now+60}])
    assert.equal(verifyAccessJwt(token({...base,...patch}),config,now),false);
  for(const header of [{alg:"none",kid:"fixture"},{alg:"RS256",kid:"unknown"},{alg:"RS256",kid:"fixture",jku:"https://evil.test"}])
    assert.equal(verifyAccessJwt(token(base,header),config,now),false);
  assert.equal(verifyAccessJwt(token()+"x",config,now),false);
  assert.equal(verifyAccessJwt(token(),{...config,expiresAt:now},now),false);
});
test("preview gate pins actual Host and requires app JWT for service tokens too",()=>{
  const headers={host:config.previewHost,"cf-access-jwt-assertion":token()};
  assert.equal(previewAccessAllowed({headers},config),true);
  assert.equal(previewAccessAllowed({headers:{host:config.previewHost,"cf-access-client-id":"service","cf-access-client-secret":"fixture"}},config),false);
  for(const host of ["main.example.test",config.previewHost+":443",config.previewHost+",evil.test","127.0.0.1"])
    assert.equal(previewAccessAllowed({headers:{...headers,host}},config),false);
  assert.equal(previewAccessAllowed({headers:{host:"evil.test","x-forwarded-host":config.previewHost,"cf-access-jwt-assertion":token()}},config),false);
  assert.equal(loadAccessConfig({}),undefined); // main and legacy have no gate by default
  assert.throws(()=>loadAccessConfig({PREVIEW_DATA_DATE:"2026-10-30"}));
});
