import {constants} from "node:fs";
import {lstat,open,mkdir} from "node:fs/promises";
import {resolve,join} from "node:path";
import {ContentServiceError} from "../../../contracts/repository.ts";
import type {ObjectStorage} from "./storage.ts";
import {verifyMediaBytes} from "./storage.ts";
import {validateMedia} from "./validation.ts";
/** Isolated local preview only; production keeps its restricted private object store. */
export function createLocalMediaStorage(directory:string,databaseUrl:string,role:"reader"|"writer"):ObjectStorage {
  try{const url=new URL(databaseUrl);if(!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!directory)throw Error();}catch{throw new ContentServiceError("MISCONFIGURED","Local media requires a loopback database.");}
  const root=resolve(directory);
  async function folder(path:string){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid()))throw Error();}
  async function pathFor(hash:string){await folder(root);await folder(join(root,"sha256"));return join(root,"sha256",hash);}
  const storage:ObjectStorage={
    async read(media){validateMedia(media);try{const file=await open(await pathFor(media.sha256),constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await file.stat();if(!s.isFile()||s.size!==media.byteSize||(s.mode&0o077)!==0)throw Error();const bytes=await file.readFile();verifyMediaBytes(media,bytes);return bytes;}finally{await file.close();}}catch{throw new ContentServiceError("CONTENT_UNAVAILABLE","Local preview media is unavailable.");}},
    async put(media,bytes){validateMedia(media);verifyMediaBytes(media,bytes);if(role!=="writer")throw new ContentServiceError("CONTENT_UNAVAILABLE","Local media reader cannot write.");
      try{await mkdir(root,{recursive:true,mode:0o700});await folder(root);await mkdir(join(root,"sha256"),{mode:0o700}).catch(e=>{if(e.code!=="EEXIST")throw e;});const path=await pathFor(media.sha256);let file;try{file=await open(path,"wx",0o600);}catch(e){if((e as {code:string}).code!=="EEXIST")throw e;await storage.read(media);return;}try{await file.writeFile(bytes);}finally{await file.close();}}catch{throw new ContentServiceError("CONTENT_UNAVAILABLE","Local preview media could not be stored.");}
    }
  };return storage;
}
