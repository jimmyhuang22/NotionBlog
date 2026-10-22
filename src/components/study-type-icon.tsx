import type { studyEntryType } from "@/lib/study-overview";

/** The same four visual cues follow a material from the overview into the reading directory. */
export function StudyTypeIcon({ type }: { type: ReturnType<typeof studyEntryType> }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {type === "Course" ? <><path d="M10 5.1C7.8 3.6 5.4 3.3 2.5 4v11.4c2.9-.7 5.3-.4 7.5 1.1 2.2-1.5 4.6-1.8 7.5-1.1V4c-2.9-.7-5.3-.4-7.5 1.1Z" /><path d="M10 5.1v11.4" /></>
      : type === "Assignment" ? <><rect x="4" y="3.5" width="12" height="14" rx="2" /><path d="M7.5 3.5V2h5v1.5M7 9l1.5 1.5L13 7M7 14h6" /></>
      : type === "eFolio" ? <><rect x="2.5" y="5" width="15" height="12" rx="2" /><path d="M6.5 5V3h7v2M2.5 10h15M8 10v2h4v-2" /></>
      : <><path d="M11.5 2.5H5a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 5 17.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5Z" /><path d="M11.5 2.5v5h5M7 11h6M7 14h4" /></>}
  </svg>;
}
