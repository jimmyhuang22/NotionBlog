import type { BlockObjectResponse, DataSourceObjectResponse, DatabaseObjectResponse, PageObjectResponse } from "@notionhq/client";

/** Server-side read boundary. Raw objects never cross into a public DTO. */
export interface NotionReadClient {
  getPage(id: string): Promise<PageObjectResponse | null>;
  getDataSource(id: string): Promise<DataSourceObjectResponse>;
  /** Used only for owned child databases in explicitly automatic study sources. */
  getDatabase?(id: string): Promise<DatabaseObjectResponse>;
  getBlock(id: string): Promise<BlockObjectResponse | null>;
  listBlocks(id: string): Promise<BlockObjectResponse[]>;
  /** Complete direct rows; the repository only reuses allowlisted learning metadata. */
  listPages?(dataSourceId: string): Promise<PageObjectResponse[]>;
}

export type ReleaseContentKind = "status" | "course" | "study-note";
export interface NotionSource {
  key: string;
  kind: ReleaseContentKind;
  dataSourceId: string;
  enabled: boolean;
  coursePageId: string | null;
  fields: Readonly<Record<string, string>>;
  cover: { strategy: "none" | "native-page-cover" | "files-property"; property?: string };
  publication: { mode: "allowlist" | "all"; allowlistPageIds: string[] };
}
export interface NotionSourcesConfig {
  schemaVersion: 1;
  sources: NotionSource[];
}
