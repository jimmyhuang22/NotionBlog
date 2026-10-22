import {constants} from 'node:fs';
import {open,lstat,realpath,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,resolve,join} from 'node:path';
export const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function directory(path,privateMode=true){
 if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)fail('PRIVATE_DIRECTORY_INVALID');
 const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(privateMode?(s.mode&511)!==448:!!(s.mode&18))||await realpath(path)!==path)fail('PRIVATE_DIRECTORY_INVALID');
}
export async function privateText(path,maxBytes=2097152){
 if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)fail('PRIVATE_INPUT_INVALID');
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await h.stat();if(!s.isFile()||(s.mode&511)!==384||s.uid!==process.getuid()||s.nlink!==1||s.size>maxBytes)fail('PRIVATE_INPUT_INVALID');
 const text=await h.readFile('utf8'),after=await h.stat();if(Buffer.byteLength(text)>maxBytes||after.size!==s.size||after.mtimeMs!==s.mtimeMs)fail('PRIVATE_INPUT_INVALID');return text;}finally{await h.close();}
}
export async function fileDigest(path,node=false){
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await h.stat();if(!s.isFile()||(s.mode&18)||(!node&&s.uid!==process.getuid())||s.size>(node?268435456:33554432))fail('RELEASE_INVALID');
 const hash=createHash('sha256');let bytes=0;for await(const part of h.createReadStream({autoClose:false})){bytes+=part.length;hash.update(part);}
 const after=await h.stat(),entry=await lstat(path);if(bytes!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||entry.ino!==s.ino||entry.dev!==s.dev||entry.isSymbolicLink())fail('RELEASE_INVALID');return hash.digest('hex');}finally{await h.close();}
}
export async function verifyRelease(project,manifestFile){
 await directory(project);const m=JSON.parse(await privateText(manifestFile));
 if(m.format!=='website-v2-release-1'||!/^[a-f0-9]{40}$/.test(m.commit)||!Array.isArray(m.files)||!m.files.length||m.files.length>5000||m.nodePath!==await realpath(process.execPath)||m.nodeVersion!==process.versions.node||!process.versions.node.startsWith('24.')||await fileDigest(m.nodePath,true)!==m.nodeSha256)fail('RELEASE_INVALID');
 try{await lstat(join(project,'.git'));fail('RELEASE_INVALID');}catch(e){if(e.code!=='ENOENT')throw e;}
 const paths=new Set();for(const f of m.files){if(typeof f.path!=='string'||!/^[a-zA-Z0-9_.\/\[\]-]+$/.test(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..')||f.path.startsWith('node_modules/')||f.path.startsWith('.git/')||! /^[a-f0-9]{64}$/.test(f.sha256)||paths.has(f.path))fail('RELEASE_INVALID');paths.add(f.path);
  if(await fileDigest(join(project,f.path))!==f.sha256)fail('RELEASE_INVALID');}
 for(const path of ['scripts/website-sync/run.ts','scripts/website-sync/run-private.mjs','scripts/website-sync/release.mjs','scripts/website-sync/runtime-reader.ts','scripts/website-sync/download.ts','scripts/website-sync/image-cache.ts','package-lock.json','database/website-protocol.json','database/website-media-protocol.json'])if(!paths.has(path))fail('RELEASE_INVALID');
 async function walk(relative=''){
  for(const entry of await readdir(join(project,relative),{withFileTypes:true})){
   if(entry.name==='node_modules')continue;
   const path=relative?relative+'/'+entry.name:entry.name;
   if(entry.isSymbolicLink())fail('RELEASE_INVALID');
   if(entry.isDirectory())await walk(path);else if(!entry.isFile()||!paths.has(path))fail('RELEASE_INVALID');
  }
 }
 await walk();
 return m;
}
