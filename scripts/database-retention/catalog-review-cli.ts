import {constants} from "node:fs";
import {open,lstat} from "node:fs/promises";
import {reviewRetentionCatalog} from "./catalog-review.ts";

async function privateJSON(path:string){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await file.stat();
    if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o077)||before.nlink!==1||before.size>2*1024*1024){
      throw Error("RETENTION_PRIVATE_FILE_INVALID");
    }
    const raw=await file.readFile("utf8"),after=await lstat(path);
    if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs)throw Error("RETENTION_PRIVATE_FILE_CHANGED");
    return JSON.parse(raw);
  }finally{await file.close();}
}

async function main(){
  const [inputFlag,input,expectedFlag,expected,...extra]=process.argv.slice(2);
  if(inputFlag!=="--input"||!input||expectedFlag!=="--expectations"||!expected||extra.length){
    throw Error("RETENTION_CATALOG_FILES_REQUIRED");
  }
  const snapshot=await privateJSON(input),expectations=await privateJSON(expected);
  console.log(JSON.stringify(reviewRetentionCatalog(snapshot,expectations)));
}
main().catch(error=>{
  const reason=error instanceof Error&&/^RETENTION_[A-Z_]+$/.test(error.message)?error.message:"RETENTION_CATALOG_REVIEW_FAILED";
  console.error(JSON.stringify({status:"REQUIRES_REVIEW",reason,databaseWrites:0}));process.exitCode=1;
});
