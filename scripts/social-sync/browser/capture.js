/** Serialized into MAIN by Chrome: keep this function self-contained and read-only. */
export function captureNote(expected){
  const match=new RegExp(`^/(?:explore|discovery/item|user/profile/${expected.accountId})/([a-f0-9]{24})/?$`).exec(location.pathname);
  if(location.protocol!=="https:"||location.hostname!=="www.xiaohongshu.com"||!match||match[1]!==expected.publicationId)return {error:"SOURCE_BLOCKED"};
  const id=match[1],state=window.__INITIAL_STATE__?.note;
  const current=state?.currentNoteId?.__v_isRef===true?state.currentNoteId.value:state?.currentNoteId;
  if(current&&current!==id)return {error:"IDENTITY_MISMATCH"};
  if(!state?.noteDetailMap||!Object.hasOwn(state.noteDetailMap,id))return {error:"NOTE_STATE_MISSING"};
  const note=state.noteDetailMap[id]?.note;
  if(!note||note.noteId!==id||note.user?.userId!==expected.accountId)return {error:"IDENTITY_MISMATCH"};
  if(expected.requireShareable&&note.shareInfo?.unShare!==false)return {error:"SOURCE_VISIBILITY_UNKNOWN"};
  const info=note.interactInfo;if(!info)return {error:"NOTE_STATE_MISSING"};
  return {version:1,source:"browser-note-state",observedAt:new Date().toISOString(),pageUrl:"https://www.xiaohongshu.com/explore/"+id,
    note:{noteId:id,userId:note.user.userId,type:note.type,title:note.title,time:note.time??null,lastUpdateTime:note.lastUpdateTime??null,
      coverUrl:note.imageList?.[0]?.urlDefault??null,interactInfo:{likedCount:info.likedCount??null,commentCount:info.commentCount??null,shareCount:info.shareCount??null,collectedCount:info.collectedCount??null}}};
}
