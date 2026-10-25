import "server-only";
import { isolatedWebsiteReader, websiteReaderIsolationMode } from "./website-reader-isolation.ts";
import { createLocalMediaStorage } from "./local-storage.ts";
import { sqlExecutor } from "./connection.ts";
import { createWebsiteDatabaseRepository } from "./website-repository.ts";
import { createDatabaseRepository } from "./repository.ts";
import { createSupabaseStorage, type ObjectStorage } from "./storage.ts";
import { createStorageReaderToken } from "./reader-auth.ts";
import { getSiteConfig } from "../../lib/site/index.ts";
import { publicationMode, publicationReader } from "./publication.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { createPublishedThumbnailReader } from "./published-thumbnails.ts";
import { configuredCosStorage, storageProvider, thumbnailStorageProvider } from "./cos-config.ts";
import { measureContentRead } from "../content-read-timing.ts";
import { readProjectionMode, scopedReader } from "./scoped-reads.ts";
import { sharedContentReaderPool } from "./shared-reader-pool.ts";
import { budgetedContentSql } from "../content-read-budget.ts";
import { readSearchContextMode } from "./search-context.ts";
import { selfHostedDisplayStore } from "../self-hosted-media/runtime.ts";
import { displayProjectionSql } from "../self-hosted-media/projection.ts";

let runtime: ReturnType<typeof createRuntime>|undefined;
function createRuntime() {
  const isolationMode=websiteReaderIsolationMode(process.env.DATABASE_READER_ISOLATION);
  const mode=publicationMode(process.env.DATABASE_PUBLICATION_MODE);
  if (mode==="published" && (process.env.DATABASE_CONTENT_VERSION!=="2" || (process.env.MEDIA_PROVIDER!==undefined && process.env.MEDIA_PROVIDER!=="storage"))) {
    throw new ContentServiceError("MISCONFIGURED", "Published content requires v2 and independent stored media.");
  }
  const projection=readProjectionMode(process.env.DATABASE_READ_PROJECTION);
  const searchContext=readSearchContextMode(process.env.DATABASE_SEARCH_CONTEXT);
  if(searchContext&&process.env.DATABASE_CONTENT_VERSION!=="2")
    throw new ContentServiceError("MISCONFIGURED","Search context requires database v2.");
  if(projection==="scoped"&&process.env.DATABASE_CONTENT_VERSION!=="2")
    throw new ContentServiceError("MISCONFIGURED","Scoped reads require database v2.");
  const pool=sharedContentReaderPool(process.env.DATABASE_READER_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT);
  const rawDb=isolatedWebsiteReader(budgetedContentSql(sqlExecutor(pool)),isolationMode);
  const db=publicationReader(rawDb,mode);
  const displayStore=selfHostedDisplayStore();
  const contentDb=displayStore?displayProjectionSql(db,displayStore):db;
  let token: ReturnType<typeof createStorageReaderToken> | undefined;
  const objectProvider=storageProvider(process.env);
  const variantProvider=thumbnailStorageProvider(process.env);
  let cosStorage: ObjectStorage | undefined;
  if (!["1","2"].includes(process.env.DATABASE_CONTENT_VERSION??"1")) throw new Error("Invalid database content version.");
  function storageFor(provider: "supabase" | "cos"): ObjectStorage {
    if (provider==="cos") return cosStorage??=configuredCosStorage(process.env,"reader",{onReadFailure:failure=>console.warn("COS_READ_FAILURE",JSON.stringify(failure))});
    if (process.env.DATABASE_MEDIA_DIRECTORY) return createLocalMediaStorage(process.env.DATABASE_MEDIA_DIRECTORY,process.env.DATABASE_READER_URL??"","reader");
    return createSupabaseStorage({
      url:process.env.STORAGE_URL??"",bucket:process.env.STORAGE_BUCKET??"",apiKey:process.env.STORAGE_API_KEY??"",
      token:token??=createStorageReaderToken({storageUrl:process.env.STORAGE_URL??"",apiKey:process.env.STORAGE_API_KEY??"",
        email:process.env.STORAGE_READER_EMAIL,password:process.env.STORAGE_READER_PASSWORD,userId:process.env.STORAGE_READER_USER_ID,
        staticToken:process.env.STORAGE_READ_TOKEN}),role:"reader",
    });
  }
  const storage=()=>storageFor(objectProvider), thumbnailStorage=()=>storageFor(variantProvider);
  return {db,displayStore,cacheStateDb:rawDb,thumbnailStorage,publishedThumbnail:mode==="published"?createPublishedThumbnailReader(rawDb):undefined,repository:(process.env.DATABASE_CONTENT_VERSION==="2"?createWebsiteDatabaseRepository:createDatabaseRepository)(projection==="scoped"?scopedReader(displayStore?displayProjectionSql(rawDb,displayStore):rawDb,mode):contentDb,{timeZone:()=>getSiteConfig().timeZone,searchContext,...(projection==="scoped"?{scoped:true}:{})}),storage};
}
export function getDatabaseRuntime() { return measureContentRead("database-runtime", () => runtime??=createRuntime()); }
