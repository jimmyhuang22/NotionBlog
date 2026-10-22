import type { DirectoryPage } from "../bilibili-discovery.ts";
interface DirectoryJob { id:string;accountId:string;expiresAt:string }
interface LinkJob extends DirectoryJob { key:string;collectionId:string;representativeId:string }
interface BrowserOptions { now?:()=>number;sleep?:(ms:number)=>Promise<void>;owned?:(id:number,value:unknown)=>Promise<void> }
export function captureBilibiliDirectoryPage(expected:{accountId:string;pageSize?:number}):DirectoryPage|{error:string};
export function nextBilibiliDirectoryPage(expected:{accountId:string;page:number}):{clicked:true}|{error:string};
export function captureBilibiliDirectory(api:unknown,job:DirectoryJob,options?:BrowserOptions):Promise<DirectoryPage[]>;
export function captureBilibiliSeasonLink(job:LinkJob):{id:string;key:string;url:string;checkedAt:string}|{error:string};
export function captureBilibiliSeasonLinks(api:unknown,jobs:LinkJob[],options?:BrowserOptions):Promise<{id:string;key:string;url:string;checkedAt:string}[]>;
