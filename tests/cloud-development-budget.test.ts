import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCloudSession, validatePlan, unusedLocalPort, type CloudPlan } from '../scripts/development/cloud-session.mjs';
const execute=promisify(execFile);
const hook=new URL('../scripts/development/cloud-network.cjs',import.meta.url).pathname;
const plan=(port:number,changes:Partial<CloudPlan>={}):CloudPlan=>({version:1,paths:['/sample?id=one'],destinations:[{host:'127.0.0.1',port}],maxRequests:2,maxConnections:2,maxReceivedBytes:1024,...changes});
const listen=(server:net.Server)=>new Promise<number>(resolve=>server.listen(0,'127.0.0.1',()=>resolve((server.address() as net.AddressInfo).port)));
const close=(server:net.Server)=>new Promise<void>(resolve=>server.close(()=>resolve()));
const receive=(port:number)=>new Promise<string>((resolve,reject)=>{const socket=net.connect(port,'127.0.0.1');let text='';socket.on('error',reject);socket.on('data',chunk=>text+=chunk);socket.on('close',()=>resolve(text));});

test('cloud plans reject unlimited budgets, extra keys and unfixed paths before any connection',()=>{
 for(const change of [{maxRequests:0},{maxReceivedBytes:16777217},{maxConnections:33},{paths:['//external.invalid']},{paths:['/_next/data/x']},{paths:['/a','/a']},{destinations:[]},{unexpected:true}])
  assert.throws(()=>validatePlan({...plan(5432),...change}));
});

test('one relay budget counts concurrent workers and stops every socket at the byte threshold',async()=>{
 const source=net.createServer(socket=>socket.end('12345678'));
 const port=await listen(source), session=await createCloudSession(plan(port,{maxReceivedBytes:12}));
 try {
  assert.equal(await receive(session.mapping[0].localPort),'12345678');
  assert.equal(await receive(session.mapping[0].localPort),'');
  assert.equal(session.state.receivedBytes,16); assert.equal(session.state.reason,'byte_limit');
 }finally{session.stop('test_complete');await close(source);}
});

test('connection limit prevents the next upstream connection rather than recording it afterwards',async()=>{
 let accepted=0;const source=net.createServer(socket=>{accepted++;socket.end('ok');});
 const port=await listen(source),session=await createCloudSession(plan(port,{maxConnections:1}));
 try{
  assert.equal(await receive(session.mapping[0].localPort),'ok');assert.equal(await receive(session.mapping[0].localPort),'');
  assert.equal(accepted,1);assert.equal(session.state.reason,'connection_limit');
 }finally{session.stop('test_complete');await close(source);}
});

test('unplanned HTTP samples, methods and prefetch cannot trigger the real Next backend',async()=>{
 let hits=0;const backend=http.createServer((_q,s)=>{hits++;s.end('local-sample');});
 const next=await listen(backend),session=await createCloudSession(plan(next)),port=await unusedLocalPort();
 try{
  await session.gateway(port,next);
  const origin=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(origin+'/unlisted')).status,403);
  assert.equal((await fetch(origin+'/sample?id=one',{method:'POST'})).status,403);
  assert.equal((await fetch(origin+'/sample?id=one&_rsc=unlisted')).status,403);assert.equal(hits,0);
  assert.equal(await(await fetch(origin+'/sample?id=one')).text(),'local-sample');
  assert.equal(await(await fetch(origin+'/sample?id=one')).text(),'local-sample');
  await fetch(origin+'/sample?id=one').catch(()=>{});
  assert.equal(hits,2);assert.equal(session.state.reason,'request_limit');
 }finally{session.stop('test_complete');backend.closeAllConnections();await close(backend);}
});

test('actual inherited Node preloader redirects only fixed destinations before DNS lookup',async()=>{
 const source=net.createServer(socket=>socket.end('metered'));
 const port=await listen(source),session=await createCloudSession(plan(port));
 try{
  const mapping=session.mapping.map(item=>({...item,host:'fixed.invalid',port:5432}));
  const code=`const net=require('node:net');let denied=false;try{net.connect(443,'unlisted.invalid')}catch(e){denied=e.code==='CLOUD_DESTINATION_BLOCKED'}const socket=net.connect(5432,'fixed.invalid');let body='';socket.on('data',c=>body+=c);socket.on('end',()=>console.log(JSON.stringify({denied,body})));`;
  const env={...process.env,NOTIONBLOG_DEVELOPMENT_MODE:'cloud',NOTIONBLOG_CLOUD_RELAY:JSON.stringify(mapping),NODE_OPTIONS:`--require=${JSON.stringify(hook)}`};
  const results=await Promise.all([execute(process.execPath,['-e',code],{env}),execute(process.execPath,['-e',code],{env})]);
  for(const result of results)assert.deepEqual(JSON.parse(result.stdout),{denied:true,body:'metered'});
  assert.equal(session.state.connections,2);assert.equal(session.state.receivedBytes,14);
 }finally{session.stop('test_complete');await close(source);}
});

test('HTTP fetch uses the relay and TLS keeps the original SNI and certificate-validation requirement',async()=>{
 const source=http.createServer((_q,s)=>s.end('via-fetch'));
 const port=await listen(source),session=await createCloudSession(plan(port));
 try{
  const mapping=session.mapping.map(item=>({...item,host:'fixed.invalid'}));
  const env={...process.env,NOTIONBLOG_DEVELOPMENT_MODE:'cloud',NOTIONBLOG_CLOUD_RELAY:JSON.stringify(mapping),NODE_OPTIONS:`--require=${JSON.stringify(hook)}`};
  const result=await execute(process.execPath,['-e',`fetch('http://fixed.invalid:${port}/').then(r=>r.text()).then(console.log)`],{env});
  assert.equal(result.stdout.trim(),'via-fetch');assert.ok(session.state.receivedBytes>9);
 }finally{session.stop('test_complete');source.closeAllConnections();await close(source);}
 let hello='';const tlsSource=net.createServer(socket=>socket.once('data',chunk=>{hello=chunk.toString('latin1');socket.end('invalid-tls-record');}));
 const tlsPort=await listen(tlsSource),tlsSession=await createCloudSession(plan(tlsPort));
 try{
  const mapping=tlsSession.mapping.map(item=>({...item,host:'fixed.invalid',port:443}));
  const env={...process.env,NOTIONBLOG_DEVELOPMENT_MODE:'cloud',NOTIONBLOG_CLOUD_RELAY:JSON.stringify(mapping),NODE_OPTIONS:`--require=${JSON.stringify(hook)}`};
  const code=`const tls=require('node:tls');const s=tls.connect({host:'fixed.invalid',port:443,servername:'fixed.invalid',rejectUnauthorized:true});s.on('secureConnect',()=>{console.log('unexpected');s.destroy()});s.on('error',e=>console.log(e.code));`;
  const result=await execute(process.execPath,['-e',code],{env});
  assert.match(hello,/fixed\.invalid/);assert.match(result.stdout,/ERR_SSL_/);assert.equal(tlsSession.state.connections,1);
 }finally{tlsSession.stop('test_complete');await close(tlsSource);}
});
