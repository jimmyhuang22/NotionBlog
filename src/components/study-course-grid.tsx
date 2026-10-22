import Link from "next/link";
import type { Course } from "../../contracts/content.ts";
import { CoverImage } from "./cover-image";
import { courseName } from "@/lib/format";
import { LinkPending } from "@/components/link-pending";

export function StudyCourseGrid({ courses }: { courses: Course[] }) {
  return <div className="course-grid course-grid--gallery">{courses.map(course => <Link key={course.id} href={course.href} prefetch={false} className="course-gallery-card" aria-label={`${course.code} ${courseName(course)}`}>
    {course.cover ? <CoverImage className="course-gallery-card__cover" image={course.cover} previewWidth={800} label="课程封面" lazy fallback={<span className="course-gallery-card__empty" aria-hidden="true">{course.code}</span>} />
      : <span className="course-gallery-card__empty" aria-hidden="true">{course.code}</span>}
    <span className="course-gallery-card__caption"><span className="course-card__code">{course.code}</span><span className="course-card__title">{courseName(course)}</span></span>
    <LinkPending />
  </Link>)}</div>;
}
