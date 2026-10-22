import type { Course } from "./content.ts";

/** Display grouping only. Membership never grants publication permission. */
export interface StudyProjectDefinition {
  slug: string;
  title: string;
  code: string | null;
  category: string | null;
  layout: "semesters" | "sections";
  /** Public course codes; null collects courses not explicitly assigned elsewhere. */
  courseCodes: string[] | null;
}

export interface StudyProject extends Omit<StudyProjectDefinition, "courseCodes"> {
  href: string;
  courses: Course[];
}
