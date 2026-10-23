// Fixed v2 host entry. Never installs a scheduler or changes publication policy.
import {constants} from 'node:fs';
import {open,lstat,unlink,mkdir,rename} from 'node:fs/promises';
import {join,dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs,parseEnv} from 'node:util';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {directory,privateText,fileDigest,verifyRelease,fail} from './release.mjs';
import {acquireLock,privateDirectory} from '../notion-sync/state.ts';
import {parseFullCollectionPlan,prepareFullCollection,verifyFullCollectionBinding} from './full-collection-control.ts';
import {createFullCollectionOwnerBroker} from './full-collection-owner.ts';
const modes=new Set(['dry-run','stage','publish']);
const keys=new Set(['format','project','manifest','privateRoot','stateDir','sourcesFile','sourceSha256','cacheDirectory','originalsDirectory','readerEnv','readerUrlFile','refreshSha256','converterSha256','timeoutSeconds','maxMediaBytes','maxCollectionBytes','notionIntervalMs','collectionConcurrency','captureCollection','fullCollection','resumeRunId','resumeIndexSha256','resumeRequestReserve','resumePostSeconds','resumeProducer','resumeQualification','resumeRecovery','resumeSource','resumeConsumerManifestSha256']);
const publicCodes=new Set(['PRIVATE_DIRECTORY_INVALID','PRIVATE_INPUT_INVALID','RELEASE_INVALID','INVALID_ARGUMENTS','RUN_BUSY','RUN_CANCELLED','WORKER_START_FAILED']);
const receiptCodes=new Set(['MISCONFIGURED','CONTENT_UNAVAILABLE','RATE_LIMITED','SCOPE_INCOMPLETE','IMAGE_REJECTED','IMAGE_UNAVAILABLE','LIMIT_EXCEEDED','BUSY','CANCELLED','LEASE_INVALID','CHECKPOINT_FAILED','RUN_BUDGET_EXCEEDED']);
const hash=text=>createHash('sha256').update(text).digest('hex');
async function input(path){await directory(dirname(path));return privateText(path);}
async function absent(path){try{await lstat(path);fail('RUN_BUSY');}catch(e){if(e.code!=='ENOENT')throw e;}}
function envText(env){return Object.entries(env).filter(([,v])=>v!==undefined).map(([k,v])=>{
 if(!/^[A-Z][A-Z0-9_]*$/.test(k)||typeof v!=='string'||/["\r\0]/.test(v))fail('PRIVATE_INPUT_INVALID');return `${k}="${v}"\n`;
}).join('');}
async function saveState(state,name,data){
 const temp=join(state,'.tmp-'+randomUUID()),h=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{try{await h.writeFile(JSON.stringify(data)+'\n');await h.sync();}finally{await h.close();}await rename(temp,join(state,name));}finally{await unlink(temp).catch(()=>{});}
}
async function childRun(project,temp,mode,seconds,signal,budgetBridge,ownerBroker){
 return new Promise((done,reject)=>{
  if(signal.aborted)return reject(Object.assign(new Error(),{code:'RUN_CANCELLED'}));
  const args=['--env-file='+temp,...(budgetBridge?['--import',join(project,'scripts/website-sync/shared-budget-preload.ts')]:[]),join(project,'scripts/website-sync/run.ts'),'--mode',mode];
  const budgetEnv=budgetBridge?{WEBSITE_SHARED_BUDGET_DIRECTORY:budgetBridge.directory,WEBSITE_SHARED_BUDGET_DIGEST:budgetBridge.planDigest,
   WEBSITE_SHARED_BUDGET_NONCE:budgetBridge.nonce,WEBSITE_SHARED_BUDGET_RUNTIME_SHA256:budgetBridge.runtimeSha256}:{};
  const child=spawn(process.execPath,args,{
   cwd:project,shell:false,stdio:ownerBroker?['inherit','inherit','inherit','ipc']:'inherit',env:{PATH:'/usr/bin:/bin',NEXT_TELEMETRY_DISABLED:'1',...budgetEnv},
  });
  const detach=ownerBroker?.attach(child);
  let forced;const cancel=()=>{child.kill('SIGTERM');forced??=setTimeout(()=>child.kill('SIGKILL'),60000);};
  signal.addEventListener('abort',cancel,{once:true});const deadline=setTimeout(cancel,(seconds+30)*1000);
  const clean=()=>{detach?.();clearTimeout(deadline);clearTimeout(forced);signal.removeEventListener('abort',cancel);};
  child.once('error',()=>{clean();reject(Object.assign(new Error(),{code:'WORKER_START_FAILED'}));});
  child.once('close',(code,signal)=>{clean();done({exitCode:code??1,forcedOrSignalled:signal!==null});});
 });
}
export async function runPrivateWebsiteWorker({configFile,mode='dry-run',check=false,sharedBudget,ownerMetadata}){
 if(!modes.has(mode))fail('INVALID_ARGUMENTS');
 const configBytes=await input(configFile),config=JSON.parse(configBytes);
 if(sharedBudget&&hash(configBytes)!==sharedBudget.runtimeSha256)fail('PRIVATE_INPUT_INVALID');
 if(config.format!=='website-v2-runtime-1'||Object.keys(config).some(k=>!keys.has(k))||
  !Number.isInteger(config.timeoutSeconds)||config.timeoutSeconds<1||config.timeoutSeconds>7200||
  (config.maxCollectionBytes!==undefined&&(!Number.isSafeInteger(config.maxCollectionBytes)||config.maxCollectionBytes<1||config.maxCollectionBytes>67108864))||
  (config.captureCollection!==undefined&&typeof config.captureCollection!=='boolean')||
  (config.collectionConcurrency!==undefined&&(!Number.isSafeInteger(config.collectionConcurrency)||config.collectionConcurrency<1||config.collectionConcurrency>4))||
  (config.notionIntervalMs!==undefined&&(!Number.isSafeInteger(config.notionIntervalMs)||config.notionIntervalMs<350||config.notionIntervalMs>5000))||
  !Number.isSafeInteger(config.maxMediaBytes)||config.maxMediaBytes<1||config.maxMediaBytes>2147483648||
  !['sourceSha256','refreshSha256','converterSha256'].every(k=>/^[a-f0-9]{64}$/.test(config[k])))fail('PRIVATE_INPUT_INVALID');
 const resume=config.resumeRunId!==undefined;
 const fullCollection=config.fullCollection===undefined?undefined:parseFullCollectionPlan(config.fullCollection,config.timeoutSeconds);
 if(fullCollection&&(mode==='dry-run'||!sharedBudget||Object.keys(config).some(k=>k.startsWith('resume')))||
  ownerMetadata!==undefined&&(!fullCollection||typeof ownerMetadata!=='function')||fullCollection&&!check&&!ownerMetadata)fail('PRIVATE_INPUT_INVALID');
 if(resume?(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(config.resumeRunId)||
  !/^[a-f0-9]{64}$/.test(config.resumeIndexSha256)||config.captureCollection!==true||mode==='dry-run'||!sharedBudget||
  !Number.isSafeInteger(config.resumeRequestReserve)||config.resumeRequestReserve<1||config.resumeRequestReserve>50000||
  !Number.isSafeInteger(config.resumePostSeconds)||config.resumePostSeconds<0||config.resumePostSeconds>7200):
  ['resumeIndexSha256','resumeRequestReserve','resumePostSeconds','resumeQualification'].some(k=>config[k]!==undefined))fail('PRIVATE_INPUT_INVALID');
 if(config.resumeQualification!==undefined&&!['original','fresh'].includes(config.resumeQualification))fail('PRIVATE_INPUT_INVALID');
 if(config.resumeProducer!==undefined&&(!resume||!config.resumeProducer||typeof config.resumeProducer!=='object'||
  Object.keys(config.resumeProducer).sort().join(',')!=='manifest,manifestSha256,project'||
  !['project','manifest','manifestSha256'].every(k=>typeof config.resumeProducer[k]==='string')))fail('PRIVATE_INPUT_INVALID');
 if(config.resumeRecovery!==undefined&&(!resume||config.resumeQualification!=='fresh'||!config.resumeProducer||typeof config.resumeRecovery!=='string'||!config.resumeRecovery||!/^[a-f0-9]{64}$/.test(config.resumeConsumerManifestSha256)))fail('PRIVATE_INPUT_INVALID');
 if(config.resumeConsumerManifestSha256!==undefined&&!config.resumeRecovery)fail('PRIVATE_INPUT_INVALID');
 if(config.resumeSource!==undefined&&(!config.resumeRecovery||!config.resumeSource||typeof config.resumeSource!=='object'||
  Object.keys(config.resumeSource).sort().join(',')!=='file,sha256'||typeof config.resumeSource.file!=='string'||
  !/^[a-f0-9]{64}$/.test(config.resumeSource.sha256)))fail('PRIVATE_INPUT_INVALID');
 const {project,privateRoot,stateDir,cacheDirectory,originalsDirectory}=config;
 const fullManifest=fullCollection?await input(config.manifest):undefined;
 const release=await verifyRelease(project,config.manifest);
 if(fullManifest&&(hash(await privateText(config.manifest))!==hash(fullManifest)||JSON.stringify(JSON.parse(fullManifest))!==JSON.stringify(release)))fail('RELEASE_INVALID');
 await directory(privateRoot);await directory(stateDir);await directory(cacheDirectory);
 if(stateDir!==join(privateRoot,'state'))fail('PRIVATE_DIRECTORY_INVALID');
 if(originalsDirectory){await directory(originalsDirectory);await directory(join(originalsDirectory,'sha256'));
  if(cacheDirectory===originalsDirectory||cacheDirectory.startsWith(originalsDirectory+sep)||originalsDirectory.startsWith(cacheDirectory+sep))fail('PRIVATE_DIRECTORY_INVALID');}
 const source=await input(config.sourcesFile);JSON.parse(source);if(hash(source)!==config.sourceSha256)fail('PRIVATE_INPUT_INVALID');
 if(fullCollection){
  const {parseWebsiteNotionConfig}=await import('../../src/server/notion/website-config.ts');
  const {configDigest}=await import('../../src/server/database/website-validation.ts');
  if(configDigest(parseWebsiteNotionConfig(JSON.parse(source)))!==fullCollection.expectation.configDigest||
   !['full-collection.ts','full-collection-control.ts','full-collection-owner.ts'].every(name=>release.files.some(f=>f.path==='scripts/website-sync/'+name)))fail('PRIVATE_INPUT_INVALID');
 }
 let recovery;
 if(config.resumeRecovery){
  const {prepareHostCaptureRecovery}=await import('./capture-recovery-compatibility.ts');
  recovery=await prepareHostCaptureRecovery({transitionId:config.resumeRecovery,
   producerProject:config.resumeProducer.project,producerManifest:config.resumeProducer.manifest,producerManifestSha256:config.resumeProducer.manifestSha256,
   consumerProject:project,consumerManifest:config.manifest,consumerManifestSha256:config.resumeConsumerManifestSha256,currentSourceText:source,previousSource:config.resumeSource});
 }
 const notion=parseEnv(await privateText(join(privateRoot,'notion-readonly.env'))),writer=parseEnv(await privateText(join(privateRoot,'supabase-worker.env'))),reader=parseEnv(await input(config.readerEnv));
 const readerUrl=config.readerUrlFile?(await input(config.readerUrlFile)).trim():reader.DATABASE_READER_URL;
 if(!notion.NOTION_TOKEN||!writer.SYNC_DATABASE_URL||!writer.STORAGE_URL||!writer.STORAGE_BUCKET||!writer.STORAGE_API_KEY||!readerUrl)fail('PRIVATE_INPUT_INVALID');
 // The shared v1 writer file may contain SYNC_MEDIA_PROVIDER=storage. Qualified
 // host releases historically ignore it and must keep their hybrid delivery.
 const publicationMode=writer.SYNC_PUBLICATION_MODE??'qualified',mediaProvider=publicationMode==='published'?(writer.SYNC_MEDIA_PROVIDER??'notion'):'notion';
 if(fullCollection&&(publicationMode!=='qualified'||mediaProvider!=='notion'))fail('PRIVATE_INPUT_INVALID');
 if(!['qualified','published'].includes(publicationMode)||!['notion','storage'].includes(mediaProvider)||
  (publicationMode==='published'&&mediaProvider!=='storage'))fail('PRIVATE_INPUT_INVALID');
 if(publicationMode==='published'&&!['src/server/database/publication.ts','database/publication-protocol.json'].every(path=>release.files.some(file=>file.path===path)))fail('RELEASE_INVALID');
 if(hash(await privateText(join(privateRoot,'refresh-writer-session.mjs')))!==config.refreshSha256||await fileDigest(join(privateRoot,'bin/heic-to-jpeg'))!==config.converterSha256)fail('PRIVATE_INPUT_INVALID');
 let budgetAccount;
 if(sharedBudget){
  if(project!==resolve(dirname(fileURLToPath(import.meta.url)),'../..')||publicationMode!=='qualified'||mediaProvider!=='notion'||
   new URL(writer.STORAGE_URL).origin!==sharedBudget.storageOrigin||
   !['shared-budget.ts','shared-budget-transport.ts','shared-budget-preload.ts','qualified-budget-cli.ts'].every(name=>release.files.some(f=>f.path==='scripts/website-sync/'+name)))fail('PRIVATE_INPUT_INVALID');
  if(!check){const {openSharedBudget}=await import('./shared-budget.ts');budgetAccount=openSharedBudget(sharedBudget.bridge);
   if(budgetAccount.plan.runtimeSha256!==sharedBudget.runtimeSha256||budgetAccount.plan.storageOrigin!==sharedBudget.storageOrigin)fail('PRIVATE_INPUT_INVALID');budgetAccount.guard();}
 }
 let resumePlan,compatibility;
 let producerReleaseCommit=release.commit;
 if(recovery){compatibility=recovery.admission;producerReleaseCommit=compatibility.producerReleaseCommit;}
 else if(config.resumeProducer){
  const {verifyCaptureProducer}=await import('./capture-release-compatibility.ts');
  compatibility=await verifyCaptureProducer({producerProject:config.resumeProducer.project,producerManifest:config.resumeProducer.manifest,producerManifestSha256:config.resumeProducer.manifestSha256,consumerProject:project,consumerManifest:config.manifest});
  producerReleaseCommit=compatibility.producerReleaseCommit;
 }
 if(resume){
  if(publicationMode!=='qualified'||mediaProvider!=='notion')fail('PRIVATE_INPUT_INVALID');
  const captureDirectory=join(stateDir,'website-v2',config.resumeRunId,'collection-private');
  await directory(captureDirectory);
  if(hash(await privateText(join(captureDirectory,'index-private.json')))!==config.resumeIndexSha256)fail('PRIVATE_INPUT_INVALID');
  const {readCollectionCaptureForRevalidation}=await import('./collection-capture.ts');
  const {parseWebsiteNotionConfig}=await import('../../src/server/notion/website-config.ts');
  const {configDigest}=await import('../../src/server/database/website-validation.ts');
  const {collectionResumePlan}=await import('./collection-resume-plan.ts');
  const saved=await readCollectionCaptureForRevalidation(captureDirectory,{runId:config.resumeRunId,sourceSha256:recovery?.mapping?.previousSourceSha256??config.sourceSha256,releaseCommit:producerReleaseCommit,configDigest:recovery?.mapping?.previousConfigDigest??configDigest(parseWebsiteNotionConfig(JSON.parse(source)))});
  if(!saved.pages.length||saved.pages.some(p=>!p.lease||p.lease.runId!==config.resumeRunId))fail('PRIVATE_INPUT_INVALID');
  resumePlan={...collectionResumePlan(recovery?saved.pages.filter(p=>p.record.detail.item.kind!=='course'):saved.pages),courseProjectionRefresh:recovery?{forcedCoursePages:saved.pages.filter(p=>p.record.detail.item.kind==='course').length,originalCaptureUnchanged:true}:undefined,qualification:config.resumeQualification??'original',compatibility,requestReserve:config.resumeRequestReserve,postSeconds:config.resumePostSeconds};
 }
 if(check)return {resumePlan,fullCollectionPlan:fullCollection,adapter:'private-host-v2',offlineCheck:true,releaseCommit:release.commit,mode,publicationMode,mediaProvider,networkChecked:false,sessionRefreshed:false,workerStarted:false,publicationEnabled:false};
 let manual,inode,unlock,temp,ownerBroker;const controller=new AbortController(),cancel=()=>controller.abort();
 process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 const runId=randomUUID(),lockPath=join(privateRoot,'manual-run.lock');
 try{
  try{manual=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e){if(e.code==='EEXIST')fail('RUN_BUSY');throw e;}
  inode=await manual.stat();await manual.writeFile(JSON.stringify({pid:process.pid,runId,adapter:'private-host-v2'})+'\n');await manual.sync();
  await absent(join(privateRoot,'writer-session.lock'));
  try{unlock=await acquireLock(stateDir,runId);}catch(e){if(e.code==='BUSY')fail('RUN_BUSY');throw e;}
  await privateDirectory(join(stateDir,'website-v2'));
  const output=join(stateDir,'website-v2',runId);await mkdir(output,{mode:0o700});await directory(output);
  const prepared=fullCollection?prepareFullCollection({runId,plan:fullCollection,timeoutSeconds:config.timeoutSeconds,
   sourceSha256:config.sourceSha256,releaseCommit:release.commit,manifestSha256:hash(fullManifest),runtimeSha256:hash(configBytes)},fullCollection.expectation.configDigest):undefined;
  if(prepared)ownerBroker=createFullCollectionOwnerBroker(runId,ownerMetadata,controller.signal,
   budget=>saveState(output,'full-collection-owner-budget-private.json',budget));
  const env={NOTION_TOKEN:notion.NOTION_TOKEN,NOTION_API_VERSION:notion.NOTION_API_VERSION,
   SYNC_DATABASE_URL:writer.SYNC_DATABASE_URL,DATABASE_TLS:'verify',DATABASE_CA_CERT:writer.DATABASE_CA_CERT,
   SYNC_PUBLICATION_MODE:publicationMode,SYNC_MEDIA_PROVIDER:mediaProvider,
   STORAGE_URL:writer.STORAGE_URL,STORAGE_BUCKET:writer.STORAGE_BUCKET,STORAGE_API_KEY:writer.STORAGE_API_KEY,
   DATABASE_READER_URL:readerUrl,READER_DATABASE_CA_CERT:reader.DATABASE_CA_CERT,
   NOTION_SOURCES_CONFIG:config.sourcesFile,WEBSITE_SOURCE_SHA256:config.sourceSha256,
   SYNC_IMAGE_CACHE_DIRECTORY:cacheDirectory,SYNC_IMAGE_ORIGINALS_DIRECTORY:originalsDirectory,
   SYNC_IMAGE_USER_AGENT:writer.SYNC_IMAGE_USER_AGENT,SYNC_WIKIMEDIA_USER_AGENT:writer.SYNC_WIKIMEDIA_USER_AGENT,
   SYNC_HEIC_CONVERTER_PATH:join(privateRoot,'bin/heic-to-jpeg'),
   WEBSITE_PRIVATE_ROOT:privateRoot,WEBSITE_STATE_DIR:stateDir,WEBSITE_RUN_ID:runId,WEBSITE_PARENT_PID:String(process.pid),
   WEBSITE_COLLECTION_MAX_BYTES:String(config.maxCollectionBytes??16777216),
   WEBSITE_OUTPUT_DIR:output,WEBSITE_TIMEOUT_SECONDS:String(config.timeoutSeconds),WEBSITE_MEDIA_MAX_BYTES:String(config.maxMediaBytes),
   WEBSITE_CAPTURE_COLLECTION:String(config.captureCollection??false),
   WEBSITE_FULL_COLLECTION_PREPARED:prepared?Buffer.from(JSON.stringify(prepared)).toString('base64url'):undefined,
   WEBSITE_FULL_COLLECTION_OWNER_NONCE:ownerBroker?.nonce,
   WEBSITE_RESUME_QUALIFICATION:resume?(config.resumeQualification??'original'):undefined,
   WEBSITE_RESUME_RUN_ID:config.resumeRunId,WEBSITE_RESUME_INDEX_SHA256:config.resumeIndexSha256,
   WEBSITE_RESUME_REQUEST_RESERVE:resume?String(config.resumeRequestReserve):undefined,
   WEBSITE_RESUME_POST_SECONDS:resume?String(config.resumePostSeconds):undefined,
   WEBSITE_RESUME_RECOVERY_ID:config.resumeRecovery,WEBSITE_RESUME_CONSUMER_MANIFEST_SHA256:config.resumeConsumerManifestSha256,
   WEBSITE_RESUME_SOURCE_FILE:config.resumeSource?.file,WEBSITE_RESUME_SOURCE_SHA256:config.resumeSource?.sha256,
   WEBSITE_RESUME_PRODUCER_PROJECT:config.resumeProducer?.project,WEBSITE_RESUME_PRODUCER_MANIFEST:config.resumeProducer?.manifest,
   WEBSITE_RESUME_PRODUCER_MANIFEST_SHA256:config.resumeProducer?.manifestSha256,WEBSITE_CONSUMER_MANIFEST:config.resumeProducer?config.manifest:undefined,
   WEBSITE_COLLECTION_CONCURRENCY:String(config.collectionConcurrency??1),
   WEBSITE_NOTION_INTERVAL_MS:String(config.notionIntervalMs??700),
   WEBSITE_REFRESH_SHA256:config.refreshSha256,WEBSITE_RELEASE_COMMIT:release.commit};
  temp=join(privateRoot,`.website-runtime-env-${randomUUID()}`);const h=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await h.writeFile(envText(env));await h.sync();}finally{await h.close();}
  const result=await childRun(project,temp,mode,config.timeoutSeconds,controller.signal,sharedBudget?.bridge,ownerBroker);
  if(ownerBroker){try{await ownerBroker.close();}catch{result.exitCode=1;}result.ownerMetadata=ownerBroker.statistics();
   await saveState(output,'full-collection-owner-budget-private.json',result.ownerMetadata);
   if(result.ownerMetadata.failed||result.ownerMetadata.queryCount!==1)result.exitCode=1;}
  if(budgetAccount){try{result.budgetFailure=budgetAccount.read().failure;}catch{result.budgetFailure='SHARED_BUDGET_UNAVAILABLE';}
   if(result.budgetFailure)result.exitCode=1;}
  let receipt;try{receipt=JSON.parse(await privateText(join(output,'receipt-private.json')));}catch{ /* Missing/truncated receipts cannot prove a publication did not commit. */ }
  let receiptValid=receipt?.runId===runId&&receipt?.mode===mode&&
   (publicationMode!=='published'||(receipt.publicationMode===publicationMode&&receipt.mediaProvider===mediaProvider));
  let fullCollectionBinding;
  if(prepared){try{fullCollectionBinding=verifyFullCollectionBinding(prepared,receipt?.fullCollectionBinding);
   if(receipt.resumeQualification!==undefined||JSON.stringify(receipt.fullCollectionQualification)!==JSON.stringify(fullCollectionBinding.qualification))receiptValid=false;
  }catch{receiptValid=false;}}
  else if(receipt?.fullCollectionBinding!==undefined||receipt?.fullCollectionQualification!==undefined)receiptValid=false;
  if(result.exitCode===0&&(!receiptValid||(mode==='publish'&&!(receipt.published===true&&receipt.readerVerified===true&&receipt.cloudRunId===runId))))result.exitCode=1;
  const summary={adapter:'private-host-v2',...result,runId,mode,publicationMode,mediaProvider,releaseCommit:release.commit,outcome:receiptValid?receipt.outcome:'receipt-unavailable',
   code:receiptValid&&receiptCodes.has(receipt.code)?receipt.code:undefined,
   published:receiptValid?receipt.published:undefined,readerVerified:receiptValid?receipt.readerVerified:false,
   thumbnailHandoffStatus:receiptValid?receipt.thumbnailHandoffStatus:undefined,thumbnailHandoff:receiptValid?receipt.thumbnailHandoff:undefined,
   fullCollectionBinding:receiptValid?fullCollectionBinding:undefined,
   publicationMayHaveCommitted:mode==='publish'&&(receiptValid?!!receipt.promoteRequested:true),requiresReceiptCheck:result.exitCode!==0};
  await saveState(join(stateDir,'website-v2'),'latest-run-private.json',summary);
  if(result.exitCode===0&&mode==='publish')await saveState(join(stateDir,'website-v2'),'last-success-private.json',{...summary,sourceSha256:config.sourceSha256});
  return summary;
 }finally{
  process.off('SIGINT',cancel);process.off('SIGTERM',cancel);if(temp)await unlink(temp).catch(()=>{});
  await ownerBroker?.close().catch(()=>{});
  try{await unlock?.();}
  finally{
   try{await manual?.close();}
   finally{if(inode){const now=await lstat(lockPath).catch(()=>null);if(now?.ino===inode.ino&&now?.dev===inode.dev&&!now.isSymbolicLink())await unlink(lockPath);}}
  }
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const {values}=parseArgs({options:{config:{type:'string'},mode:{type:'string'},check:{type:'boolean'}},strict:true,allowPositionals:false});
  const r=await runPrivateWebsiteWorker({configFile:values.config,mode:values.mode,check:values.check});console.log(JSON.stringify(r));process.exitCode=r.exitCode??0;
 }catch(e){console.error(JSON.stringify({adapter:'private-host-v2',outcome:'preparation-failed',code:publicCodes.has(e.code)?e.code:'PREPARATION_FAILED'}));process.exitCode=e.code==='RUN_BUSY'?75:1;}
}
