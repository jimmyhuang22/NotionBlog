import type { Course } from "../../contracts/content.ts";
import type { StudyProject, StudyProjectDefinition } from "../../contracts/study.ts";

const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() || null : null;

/** Optional private site configuration; malformed entries never turn into a catch-all. */
export function parseStudyProjects(value: unknown): StudyProjectDefinition[] {
  if (!Array.isArray(value)) return [];
  const result: StudyProjectDefinition[] = [], slugs = new Set<string>();
  for (const raw of value.slice(0, 40)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const p = raw as Record<string, unknown>, slug = text(p.slug, 64), title = text(p.title, 160);
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || !title || slugs.has(slug)) continue;
    if (p.courseCodes !== null && (!Array.isArray(p.courseCodes) || p.courseCodes.length > 1000 || p.courseCodes.some(code => !text(code, 80)))) continue;
    slugs.add(slug);
    result.push({ slug, title, code: text(p.code, 40), category: text(p.category, 60),
      layout: p.layout === "sections" ? "sections" : "semesters",
      courseCodes: p.courseCodes === null ? null : [...new Set((p.courseCodes as string[]).map(code => code.trim().toUpperCase()))] });
  }
  return result;
}

/** Only the repository's eligible courses are considered, including for configured membership. */
export function studyProjects(courses: Course[], definitions?: StudyProjectDefinition[]): StudyProject[] {
  const rules = definitions ?? [{ slug: "courses", title: "课程笔记", code: null, category: null, layout: "semesters", courseCodes: null }];
  const explicit = new Set(rules.flatMap(p => p.courseCodes ?? []));
  const assigned = new Set<string>();
  return rules.map(p => {
    const members = courses.filter(course => {
      const code = course.code?.toUpperCase() ?? null;
      return !assigned.has(course.id) && (p.courseCodes === null ? code === null || !explicit.has(code) : code !== null && p.courseCodes.includes(code));
    });
    members.forEach(course => assigned.add(course.id));
    return { slug: p.slug, title: p.title, code: p.code, category: p.category, layout: p.layout,
      href: `/study/projects/${p.slug}`, courses: members };
  }).filter(p => p.courses.length > 0);
}

/** Resolve a breadcrumb from the course already qualified for this page; no catalogue read. */
export function studyProjectForCourse(course: Course, definitions?: StudyProjectDefinition[]): StudyProject | null {
  return studyProjects([course], definitions)[0] ?? null;
}

export function coursesBySemester(courses: Course[]): [string | null, Course[]][] {
  const groups = new Map<string | null, Course[]>();
  for (const course of courses) groups.set(course.semester, [...(groups.get(course.semester) ?? []), course]);
  return [...groups].sort(([a], [b]) => a === null ? b === null ? 0 : 1 : b === null ? -1 : a.localeCompare(b));
}
