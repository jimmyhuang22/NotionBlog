export function readProfile(filename: string, localOnly?: boolean): Record<string, string>;
export function buildMarker(root: string): { version: number; buildId: string; requiredFilesSha256: string };
export function verifyBuild(root: string): void;
