"use client";

import Link from "next/link";
import { useStudyLinkContexts } from "./study-reading-context";

export function StudyChildPageLink({ href, title }: { href: string; title: string }) {
  const labels = useStudyLinkContexts();
  return <Link className="child-page" prefetch={false} href={href}><span className="study-link-title"><span>{title}</span>{labels[href] ? <small>{labels[href]}</small> : null}</span><span aria-hidden="true">›</span></Link>;
}
