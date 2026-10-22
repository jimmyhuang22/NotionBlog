import { ContentServiceError } from "../../../contracts/repository.ts";

/** Statistics age is presentation metadata, never an approval switch or a rewritten observation. */
export function socialSampleStatus(platform:"bilibili"|"xiaohongshu",observedAt:string,now=new Date().toISOString()) {
  const period=platform==="bilibili"?6*3600000:platform==="xiaohongshu"?24*3600000:null;
  const valid=(at:string)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)&&Number.isFinite(Date.parse(at))&&new Date(at).toISOString()===at;
  if(period===null||!valid(observedAt)||!valid(now)||Date.parse(observedAt)>Date.parse(now)+30000)throw new ContentServiceError("CONTENT_UNAVAILABLE","Social sample time is incompatible.");
  const nextExpectedAt=new Date(Date.parse(observedAt)+period).toISOString();
  return {observedAt,nextExpectedAt,overdue:Date.parse(now)>=Date.parse(nextExpectedAt)};
}
