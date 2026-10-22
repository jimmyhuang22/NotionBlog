import { captureJob } from "./driver.js";
import { captureBilibiliDirectory,captureBilibiliSeasonLinks } from "./bilibili-directory.js";
import { captureXhsDirectory } from "./xiaohongshu-directory.js";
const HOST="com.notionblog.social_refresh",ALARM="reviewed-notes-check",CONTINUE="reviewed-notes-continue";
const B_ALARM="bilibili-account-check",B_CONTINUE="bilibili-account-continue";
const XHS_DISCOVERY="xiaohongshu-account-check";
const XHS_NOTES="xiaohongshu-exception-check",XHS_NOTES_CONTINUE="xiaohongshu-exception-continue";
let running=false;
let bilibiliRunning=false;
let xhsDiscoveryRunning=false;
let xhsNotesRunning=false;
// A short native port keeps the service worker alive during a bounded upload. No permanent host.
function native(message){return new Promise((resolve,reject)=>{
  const port=chrome.runtime.connectNative(HOST),timer=setTimeout(()=>finish(Error("BRIDGE_DISCONNECTED")),125000);
  const finish=(error,value)=>{clearTimeout(timer);port.onMessage.removeListener(onMessage);port.onDisconnect.removeListener(onDisconnect);port.disconnect();if(error)reject(error);else resolve(value);};
  const onMessage=value=>value?.error?finish(Error(value.error)):finish(null,value);
  const onDisconnect=()=>{void chrome.runtime.lastError;finish(Error("BRIDGE_DISCONNECTED"));};
  port.onMessage.addListener(onMessage);port.onDisconnect.addListener(onDisconnect);port.postMessage(message);
});}
async function owned(id,target){const {ownedTabs={}}=await chrome.storage.session.get("ownedTabs");if(target)ownedTabs[id]=target.publicationId;else delete ownedTabs[id];await chrome.storage.session.set({ownedTabs});}
async function cleanup(){
  const {ownedTabs={}}=await chrome.storage.session.get("ownedTabs");
  for(const [id,noteId] of Object.entries(ownedTabs)){
    try{const tab=await chrome.tabs.get(Number(id)),u=new URL(tab.url);if(u.protocol==="https:"&&u.hostname==="www.xiaohongshu.com"&&new RegExp(`^/(?:explore|discovery/item|user/profile/[a-f0-9]{24})/${noteId}/?$`).test(u.pathname))await chrome.tabs.remove(Number(id));}catch{}
  }await chrome.storage.session.set({ownedTabs:{}});
}
const ready=cleanup();
async function ownedDirectory(id,account){if(account)await chrome.storage.session.set({ownedDirectory:{id,account}});else await chrome.storage.session.remove("ownedDirectory");}
async function cleanupDirectory(){const {ownedDirectory: t}=await chrome.storage.session.get("ownedDirectory");if(t){
  try{const tab=await chrome.tabs.get(t.id),u=new URL(tab.url);if(u.origin==="https://space.bilibili.com"&&u.pathname===`/${t.account}/upload/video`&&!u.search)await chrome.tabs.remove(t.id);}catch{}
  await chrome.storage.session.remove("ownedDirectory");
}}
async function ownedLink(id,value){if(value)await chrome.storage.session.set({ownedSeasonLink:{id,...value}});else await chrome.storage.session.remove("ownedSeasonLink");}
async function cleanupLink(){const {ownedSeasonLink:t}=await chrome.storage.session.get("ownedSeasonLink");if(t){
  try{const tab=await chrome.tabs.get(t.id);if(tab.url===`https://space.bilibili.com/${t.account}/lists/${t.collection}?type=season`)await chrome.tabs.remove(t.id);}catch{}
  await chrome.storage.session.remove("ownedSeasonLink");
}}
const directoryReady=cleanupDirectory();
const linkReady=cleanupLink();
async function ownedXhsDirectory(id,account){if(account)await chrome.storage.session.set({ownedXhsDirectory:{id,account}});else await chrome.storage.session.remove("ownedXhsDirectory");}
async function cleanupXhsDirectory(){const {ownedXhsDirectory:t}=await chrome.storage.session.get("ownedXhsDirectory");if(t){try{const tab=await chrome.tabs.get(t.id);if(tab.url===`https://www.xiaohongshu.com/user/profile/${t.account}`)await chrome.tabs.remove(t.id);}catch{}await chrome.storage.session.remove("ownedXhsDirectory");}}
const xhsDirectoryReady=cleanupXhsDirectory();
async function badge(text,title){await chrome.action.setBadgeText({text});await chrome.action.setTitle({title});}
async function syncAlarm(){
  try{const settings=await native({op:"settings"});if(settings.enabled){
      if(settings.xiaohongshuEnabled===false){await chrome.alarms.clear(ALARM);await chrome.alarms.clear(CONTINUE);await chrome.storage.session.remove("cycleId");}
      else if(!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{delayInMinutes:settings.periodMinutes,periodInMinutes:settings.periodMinutes});
      if(await chrome.permissions.contains({origins:["https://space.bilibili.com/*"]})&&!await chrome.alarms.get(B_ALARM))await chrome.alarms.create(B_ALARM,{delayInMinutes:15,periodInMinutes:15});
      if(settings.xiaohongshuDiscovery&&!await chrome.alarms.get(XHS_DISCOVERY))await chrome.alarms.create(XHS_DISCOVERY,{delayInMinutes:1,periodInMinutes:60});
      else if(!settings.xiaohongshuDiscovery)await chrome.alarms.clear(XHS_DISCOVERY);
      if(settings.xiaohongshuDiscovery&&!await chrome.alarms.get(XHS_NOTES))await chrome.alarms.create(XHS_NOTES,{delayInMinutes:2,periodInMinutes:15});
      else if(!settings.xiaohongshuDiscovery){await chrome.alarms.clear(XHS_NOTES);await chrome.alarms.clear(XHS_NOTES_CONTINUE);}
    }else {await chrome.alarms.clear(ALARM);await chrome.alarms.clear(CONTINUE);await chrome.alarms.clear(B_ALARM);await chrome.alarms.clear(B_CONTINUE);await chrome.alarms.clear(XHS_DISCOVERY);await chrome.alarms.clear(XHS_NOTES);await chrome.alarms.clear(XHS_NOTES_CONTINUE);}}
  catch{await badge("!","本机刷新程序不可用");}
}
// One job per event stays below Chrome's five-minute event limit. Durable native state resumes
// through a one-shot continuation alarm; a local due-check alarm starts/resumes a bounded cycle.
async function run(continuation=false,manual=false){
  if(running){if(continuation)await chrome.alarms.create(CONTINUE,{delayInMinutes:0.5});return;}
  running=true;let cycleId=null;
  try{
    await ready;
    const stored=await chrome.storage.session.get("cycleId");
    if(continuation&&stored.cycleId)cycleId=stored.cycleId;
    else {const start=await native({op:"start",manual});
      if(start.status==="http-managed"){await chrome.alarms.clear(ALARM);await chrome.alarms.clear(CONTINUE);await chrome.storage.session.remove("cycleId");await badge("","小红书统计由本机 HTTP 任务刷新");return;}
      cycleId=start.cycleId;await chrome.storage.session.set({cycleId});}
    await badge("…","正在刷新已审核笔记统计");
    const next=await native({op:"next",cycleId});
    let result=next;
    if(next.status==="running"&&next.job){
      const snapshots=await captureJob(chrome,next.job,{owned});
      result=await native({op:"submit",cycleId,jobId:next.job.id,snapshots});
    }
    if(result.status==="running")await chrome.alarms.create(CONTINUE,{delayInMinutes:0.5});
    else {await chrome.alarms.clear(CONTINUE);await chrome.storage.session.remove("cycleId");await badge(result.status==="complete"?"":"!",`刷新状态：${result.status}；已上传 ${result.uploaded}，剩余 ${result.remaining}`);}
  }catch(e){
    if(e?.message==="BUSY"){await chrome.alarms.create(CONTINUE,{delayInMinutes:0.5});await badge("…","等待其他社交任务释放锁");return;}
    const known=["SOURCE_BLOCKED","IDENTITY_MISMATCH","BROWSER_TIMEOUT","BRIDGE_DISCONNECTED"],code=known.includes(e?.message)?e.message:"BROWSER_REQUIRED";
    if(cycleId)await native({op:"pause",cycleId,code}).catch(()=>{});
    await chrome.alarms.clear(CONTINUE);await chrome.storage.session.remove("cycleId");await badge("!",`刷新已暂停：${code}`);
  }finally{running=false;}
}
async function runBilibili(continuation=false,manual=false){
  if(bilibiliRunning)return;bilibiliRunning=true;
  try{
    await directoryReady;
    await linkReady;
    let result=await native({op:continuation?"bilibili-next":"bilibili-start",...(continuation?{}:{manual})});
    if(result.job){const pages=await captureBilibiliDirectory(chrome,result.job,{owned:ownedDirectory});result=await native({op:"bilibili-submit",jobId:result.job.id,pages});}
    if(result.linkJobs){const proofs=await captureBilibiliSeasonLinks(chrome,result.linkJobs,{owned:ownedLink});result=await native({op:"bilibili-links",proofs});}
    if(result.status!=="paused"&&(result.status==="processing"||result.pendingLinks)&&!result.deferred&&!result.nextAt)await chrome.alarms.create(B_CONTINUE,{delayInMinutes:0.5});
    else await chrome.alarms.clear(B_CONTINUE);
    await chrome.storage.session.set({bilibiliStatus:result});
  }catch(e){
    if(e?.message!=="BUSY")await native({op:"bilibili-pause",code:/^[A-Z][A-Z_]{0,63}$/.test(e?.message)?e.message:"BROWSER_REQUIRED"}).catch(()=>{});
    await chrome.alarms.clear(B_CONTINUE);await chrome.storage.session.set({bilibiliStatus:{status:"paused",code:e?.message||"BROWSER_REQUIRED"}});
  }finally{bilibiliRunning=false;}
}
async function runXhsDiscovery(manual=false){
  if(xhsDiscoveryRunning)return;xhsDiscoveryRunning=true;
  try{await xhsDirectoryReady;let result=await native({op:"xiaohongshu-start",manual});
    if(result.job){const directory=await captureXhsDirectory(chrome,result.job,{owned:ownedXhsDirectory});result=await native({op:"xiaohongshu-submit",jobId:result.job.id,directory});}
    await chrome.storage.session.set({xiaohongshuDiscoveryStatus:result});if(result.status==="complete")await runXhsNotes(manual);
  }catch(e){if(e?.message!=="BUSY")await native({op:"xiaohongshu-pause",code:/^[A-Z][A-Z_]{0,63}$/.test(e?.message)?e.message:"BROWSER_REQUIRED"}).catch(()=>{});
    await chrome.storage.session.set({xiaohongshuDiscoveryStatus:{status:"paused",code:e?.message||"BROWSER_REQUIRED"}});
  }finally{xhsDiscoveryRunning=false;}
}
async function runXhsNotes(manual=false){
  if(xhsNotesRunning)return;xhsNotesRunning=true;
  try{await ready;const next=await native({op:"xiaohongshu-notes-start",manual});let result=next;
    if(next.job){const snapshots=await captureJob(chrome,next.job,{owned,diagnostics:true});result=await native({op:"xiaohongshu-notes-submit",jobId:next.job.id,snapshots});}
    if(result.status!=="paused"&&!result.deferred)result=await native({op:"xiaohongshu-notes-upload"});
    await chrome.storage.session.set({xiaohongshuNotesStatus:result});
    if(next.pending>3&&result.status!=="paused"&&!result.deferred)await chrome.alarms.create(XHS_NOTES_CONTINUE,{delayInMinutes:0.5});else await chrome.alarms.clear(XHS_NOTES_CONTINUE);
  }catch(e){if(e?.message!=="BUSY")await native({op:"xiaohongshu-notes-pause",code:/^[A-Z][A-Z_]{0,63}$/.test(e?.message)?e.message:"BROWSER_REQUIRED",...(e?.diagnostic?{diagnostic:e.diagnostic}:{})}).catch(()=>{});await chrome.alarms.clear(XHS_NOTES_CONTINUE);await chrome.storage.session.set({xiaohongshuNotesStatus:{status:"paused",code:e?.message||"BROWSER_REQUIRED"}});
  }finally{xhsNotesRunning=false;}
}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM||alarm.name===CONTINUE)void run(alarm.name===CONTINUE);else if(alarm.name===B_ALARM||alarm.name===B_CONTINUE)void runBilibili(alarm.name===B_CONTINUE);else if(alarm.name===XHS_DISCOVERY)void runXhsDiscovery();else if(alarm.name===XHS_NOTES||alarm.name===XHS_NOTES_CONTINUE)void runXhsNotes();});
chrome.action.onClicked.addListener(()=>{void run(false,true);void runBilibili(false,true);void runXhsDiscovery(true);});
chrome.runtime.onStartup.addListener(()=>void syncAlarm());
chrome.runtime.onInstalled.addListener(()=>void syncAlarm());
void syncAlarm();
