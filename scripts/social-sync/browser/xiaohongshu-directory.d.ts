import type { XhsDirectory,XhsDirectoryCard } from "../xiaohongshu-account.ts";
interface Job{id:string;accountId:string;expiresAt:string;knownIds:string[]}
export function captureXhsDirectoryPage(expected:{accountId:string}):{cards:XhsDirectoryCard[];observedAt:string}|{error:string};
export function scrollXhsDirectory(expected:{accountId:string}):{scrolled:true}|{error:string};
export function captureXhsDirectory(api:unknown,job:Job,options?:{now?:()=>number;sleep?:(ms:number)=>Promise<void>;owned?:(id:number,account:string|null)=>Promise<void>}):Promise<XhsDirectory>;
