import type { Project } from "../../contracts/content.ts";
import { rangeLabel } from "./format.ts";

/** Role and period on one quiet line; an unknown period is stated, an unknown role is left out. */
export function projectMeta(project: Project, timeZone: string): string {
  return [project.role, rangeLabel(project.period, timeZone) ?? "时间未记录"].filter(Boolean).join(" · ");
}

/** Only ordinary web links are offered; anything else in the source is not turned into a link. */
export function projectLinks(project: Project): Project["links"] {
  return project.links.filter(link => link.label.trim() && /^https?:\/\//iu.test(link.url));
}
