import { SectionWaiting } from "@/components/section-waiting";

/**
 * Shown while the works list is read: the page's head with its platform and order switches, and faint cards in
 * the default platform's shape, so the page keeps its shape when the works arrive. It also keeps a prefetch of
 * this page from reading the list itself.
 */
export default function WorksLoading() {
  return <SectionWaiting path="/works" />;
}
