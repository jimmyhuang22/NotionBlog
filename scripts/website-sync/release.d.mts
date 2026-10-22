export function directory(path: string, privateMode?: boolean): Promise<void>;
export function privateText(path: string, maxBytes?: number): Promise<string>;
export function fail(code: string): never;
export function verifyRelease(project: string, manifestFile: string): Promise<{
  commit: string; nodePath: string; nodeVersion: string; nodeSha256: string;
  files: { path: string; sha256: string }[];
}>;
