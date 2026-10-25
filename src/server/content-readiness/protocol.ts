export const READINESS_PATH = "/api/internal/content-readiness";
export const READINESS_FORMAT = "private-content-readiness-v1";
export const readinessUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export const readinessNonce = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export interface ReadinessSample { id: string; slug: string }
export function validReadinessSample(value: unknown): value is ReadinessSample {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sample = value as ReadinessSample;
  return Object.keys(sample).length === 2 && typeof sample.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sample.id) &&
    typeof sample.slug === "string" && sample.slug.length > 0 && Buffer.byteLength(sample.slug) <= 256 && !/[\u0000-\u0020\u007f/?#\\]/.test(sample.slug);
}
