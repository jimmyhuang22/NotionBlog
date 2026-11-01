export function readProfile(filename: string, localOnly?: boolean): Record<string, string>;
export function readerLogin(url: string, username: string, publicWebsite?: boolean): string;
export function buildMarker(root: string, publicWebsite?: boolean): { version: number; buildId: string; requiredFilesSha256: string; deployment?: string };
export function verifyBuild(root: string, publicWebsite?: boolean): void;
