import {readFile,lstat} from "node:fs/promises";
import {scheduledTick,inspectScheduledReadiness} from "./schedule.ts";

async function main(){
 const [flag,path,...extra]=process.argv.slice(2);if(!["--config","--check"].includes(flag)||!path||extra.length)throw Error("RETENTION_EXPLICIT_CONFIG_REQUIRED");
 const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid?.())throw Error("RETENTION_PRIVATE_CONFIG_INVALID");
 const config=JSON.parse(await readFile(path,"utf8"));
 const result=flag==="--check"?await inspectScheduledReadiness(config):await scheduledTick(config);console.log(JSON.stringify(result));
 if(result.status==="STOPPED"||result.status==="REQUIRES_REVIEW")process.exitCode=1;
}
main().catch(()=>{console.error(JSON.stringify({status:"STOPPED",reason:"RETENTION_CONFIGURATION_REQUIRES_REVIEW",websiteSyncChanged:false}));process.exitCode=1;});
