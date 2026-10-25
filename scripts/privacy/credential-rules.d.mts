export function credentialAssignment(body: string, path?: string): boolean;
export function databaseCredential(body: string, path?: string): boolean;
export function contentFindings(body: string, path?: string): string[];
export function matchesPrivateValue(body: string, privateValues: string[]): boolean;
export function sensitiveLocation(path: string, privateValues: string[]): boolean;
