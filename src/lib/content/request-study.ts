import type { ContentByKind, ContentDetail, Course } from "../../../contracts/content.ts";
import type { ContentRepository } from "../../../contracts/repository.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

/** One instance per React render. Queue entries are discarded after every batch. */
export function requestStudyRepository(repository: ContentRepository): ContentRepository {
  if(!repository.readStudyNote)return repository;
  const courses=new Map<string,ReturnType<typeof deferred<Course|null>>>();
  const notes=new Map<string,ReturnType<typeof deferred<ContentDetail<ContentByKind["study-note"]>|null>>>();
  const courseDetails=new Map<string,Promise<ContentDetail<Course>|null>>();
  let scheduled=false;
  const courseMetadata=(slug:string)=>repository.getCourseMetadata ? repository.getCourseMetadata(slug) : repository.get("course",slug).then(detail=>detail?.item??null);
  function schedule() {
    if(scheduled)return;scheduled=true;
    setImmediate(()=>{
      scheduled=false;
      const owners=[...courses],bodies=[...notes];courses.clear();notes.clear();
      if(owners.length===1&&bodies.length===1) {
        const [[courseSlug,owner]] = owners,[[noteSlug,note]]=bodies;
        void repository.readStudyNote!(courseSlug,noteSlug).then(pair=>{
          owner.resolve(pair?.course??null);
          if(pair?.note)note.resolve(pair.note);
          // A generic get still returns an eligible note from another course;
          // the route owns the mismatch check. Missing pairs must not change it.
          else void repository.get("study-note",noteSlug).then(note.resolve,note.reject);
        },error=>{owner.reject(error);note.reject(error);});
      } else {
        for(const [slug,owner] of owners)void courseMetadata(slug).then(owner.resolve,owner.reject);
        for(const [slug,note] of bodies)void repository.get("study-note",slug).then(note.resolve,note.reject);
      }
    });
  }
  return {...repository,
    getCourseMetadata(slug) {
      const known=courseDetails.get(slug);if(known)return known.then(detail=>detail?.item??null);
      let work=courses.get(slug);if(!work){work=deferred<Course|null>();courses.set(slug,work);schedule();}return work.promise;
    },
    get(kind,slug) {
      if(kind==="course") {
        const detail=repository.get("course",slug);courseDetails.set(slug,detail);
        return detail as Promise<ContentDetail<ContentByKind[typeof kind]>|null>;
      }
      if(kind!=="study-note")return repository.get(kind,slug);
      let work=notes.get(slug);if(!work){work=deferred<ContentDetail<ContentByKind["study-note"]>|null>();notes.set(slug,work);schedule();}
      return work.promise as Promise<ContentDetail<ContentByKind[typeof kind]>|null>;
    },
  };
}
