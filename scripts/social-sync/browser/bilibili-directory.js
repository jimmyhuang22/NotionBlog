/** Only rendered, public upload-card links and the visible pager; no Cookie/API/hidden state. */
export function captureBilibiliDirectoryPage(expected) {
  try {
    if (!/^[1-9][0-9]{0,19}$/.test(expected.accountId) || location.origin !== "https://space.bilibili.com" ||
        location.pathname !== `/${expected.accountId}/upload/video` || location.search) return { error: "IDENTITY_MISMATCH" };
    const pager = document.querySelector('.video-pagination[aria-label="分页"]');
    if (!pager) return { error: "DIRECTORY_NOT_READY" };
    const summary = /共\s*(\d+)\s*页\s*\/\s*(\d+)\s*个/.exec(pager.textContent || "");
    const current = [...pager.querySelectorAll("button[aria-label]")].map(e => /^第 (\d+) 页，当前页$/.exec(e.getAttribute("aria-label"))).filter(Boolean);
    if (!summary || current.length !== 1) return { error: "DIRECTORY_NOT_READY" };
    const ids = [];
    for (const a of document.querySelectorAll(".upload-video-card__main .bili-video-card__cover a.bili-cover-card[href]")) {
      const u = new URL(a.getAttribute("href"), location.href), m = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(u.pathname);
      if (u.protocol !== "https:" || u.hostname !== "www.bilibili.com" || u.port || u.username || u.password || !m) return { error: "IDENTITY_MISMATCH" };
      ids.push(m[1]);
    }
    const page = Number(current[0][1]), pages = Number(summary[1]), total = Number(summary[2]);
    const pageSize=expected.pageSize??(page===1?ids.length:0);
    if (!Number.isInteger(pageSize)||pageSize<1||pageSize>100||pages !== Math.ceil(total / pageSize) || total < 1 || total > 1000 || page < 1 || page > pages ||
        ids.length !== Math.min(pageSize, total - (page - 1) * pageSize) || new Set(ids).size !== ids.length) return { error: "DIRECTORY_NOT_READY" };
    return { version: 1, accountId: expected.accountId, observedAt: new Date().toISOString(), page, pageSize, pages, total, ids };
  } catch { return { error: "DIRECTORY_INVALID" }; }
}

export function captureBilibiliSeasonLink(job){
  const expected=`https://space.bilibili.com/${job.accountId}/lists/${job.collectionId}?type=season`;
  if(!/^[1-9][0-9]{0,19}$/.test(job.accountId)||!/^[1-9][0-9]{0,19}$/.test(job.collectionId)||location.href!==expected)return {error:"SOURCE_BLOCKED"};
  const videos=[...document.querySelectorAll('a[href*="/video/BV"]')].map(a=>{try{const u=new URL(a.getAttribute("href"),location.href);return u.protocol==="https:"&&u.hostname==="www.bilibili.com"?u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/)?.[1]:null;}catch{return null;}}).filter(Boolean);
  if(!videos.includes(job.representativeId))return {error:"DIRECTORY_NOT_READY"};
  return {id:job.id,key:job.key,url:expected,checkedAt:new Date().toISOString()};
}
export async function captureBilibiliSeasonLinks(api,jobs,{now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),owned=async()=>{}}={}){
  if(!Array.isArray(jobs)||jobs.length<1||jobs.length>3)throw Error("DIRECTORY_INVALID");const proofs=[];
  for(const job of jobs){
    if(!/^[-a-f0-9]{36}$/.test(job.id)||!/^[a-f0-9]{64}$/.test(job.key)||!/^[1-9][0-9]{0,19}$/.test(job.accountId)||!/^[1-9][0-9]{0,19}$/.test(job.collectionId)||!/^BV[0-9A-Za-z]{10}$/.test(job.representativeId)||Date.parse(job.expiresAt)<now())throw Error("DIRECTORY_INVALID");
    const url=`https://space.bilibili.com/${job.accountId}/lists/${job.collectionId}?type=season`,tab=await api.tabs.create({url,active:false});
    if(!Number.isInteger(tab.id))throw Error("BROWSER_REQUIRED");
    try{await owned(tab.id,{account:job.accountId,collection:job.collectionId});const until=Math.min(now()+20000,Date.parse(job.expiresAt));let proof=null;
      while(now()<until){const current=await api.tabs.get(tab.id);if(current.status==="complete"){
        if(current.url!==url)throw Error("SOURCE_BLOCKED");
        const rows=await api.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:"MAIN",func:captureBilibiliSeasonLink,args:[job]});
        const p=rows.find(r=>r.frameId===0)?.result;if(p?.error&&p.error!=="DIRECTORY_NOT_READY")throw Error(p.error);if(p&&!p.error){proof=p;break;}
      }await sleep(1000);}
      if(!proof)throw Error("BROWSER_TIMEOUT");proofs.push(proof);
    }finally{await api.tabs.remove(tab.id).catch(()=>{});await owned(tab.id,null);}
  }return proofs;
}
/** Standard next-page UI action in this task's own tab. Never requests a hidden endpoint. */
export function nextBilibiliDirectoryPage(expected) {
  if (location.origin !== "https://space.bilibili.com" || location.pathname !== `/${expected.accountId}/upload/video` || location.search) return { error: "IDENTITY_MISMATCH" };
  const pager = document.querySelector('.video-pagination[aria-label="分页"]'), next = pager?.querySelector('button[aria-label="下一页"]');
  const current = pager?.querySelector(`button[aria-label="第 ${expected.page} 页，当前页"]`);
  if (!current || !next || next.disabled || next.getAttribute("aria-disabled") === "true" || next.classList.contains("vui_button--disabled")) return { error: "DIRECTORY_INVALID" };
  next.click(); return { clicked: true };
}
export async function captureBilibiliDirectory(api, job, { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), owned = async () => {} } = {}) {
  if (!job || !/^[1-9][0-9]{0,19}$/.test(job.accountId) || !/^[-a-f0-9]{36}$/.test(job.id) ||
      !Number.isFinite(Date.parse(job.expiresAt)) || Date.parse(job.expiresAt) <= now()) throw Error("DIRECTORY_INVALID");
  const tab = await api.tabs.create({ url: `https://space.bilibili.com/${job.accountId}/upload/video`, active: false });
  if (!Number.isInteger(tab.id)) throw Error("BROWSER_REQUIRED");
  const pages = [], seen = new Set(), until = Math.min(now() + 120000, Date.parse(job.expiresAt));
  try {
    await owned(tab.id, job.accountId);
    for (let page = 1; page <= 25; page++) {
      let captured = null;
      while (now() < until) {
        const current = await api.tabs.get(tab.id);
        if (current.status === "complete") {
          const u = new URL(current.url);
          if (u.origin !== "https://space.bilibili.com" || u.pathname !== `/${job.accountId}/upload/video` || u.search) throw Error("SOURCE_BLOCKED");
          const rows = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: captureBilibiliDirectoryPage, args: [{ accountId: job.accountId, ...(pages.length?{pageSize:pages[0].pageSize}:{}) }] });
          const p = rows.find(r => r.frameId === 0)?.result;
          if (p?.error && p.error !== "DIRECTORY_NOT_READY") throw Error(p.error);
          if (p && !p.error && p.page === page && p.ids.every(id => !seen.has(id))) { captured = p; break; }
        }
        await sleep(1000);
      }
      if (!captured) throw Error("BROWSER_TIMEOUT");
      if (pages.length && (captured.pageSize!==pages[0].pageSize||captured.total !== pages[0].total || captured.pages !== pages[0].pages)) throw Error("DIRECTORY_INCOMPLETE");
      pages.push(captured); for (const id of captured.ids) seen.add(id);
      if (page === captured.pages) return pages;
      const result = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: nextBilibiliDirectoryPage, args: [{ accountId: job.accountId, page }] });
      if (!result.find(r => r.frameId === 0)?.result?.clicked) throw Error("DIRECTORY_INVALID");
    }
    throw Error("DIRECTORY_INCOMPLETE");
  } finally { await api.tabs.remove(tab.id).catch(() => {}); await owned(tab.id, null); }
}
