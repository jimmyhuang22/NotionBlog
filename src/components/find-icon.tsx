/** The magnifier both course finders draw: the overview's and the reading directory's (S16-6). */
export function FindIcon() {
  return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.6" /><path d="m10.5 10.5 3.2 3.2" strokeLinecap="round" /></svg>;
}

/** How many materials a course finder searches: every entry, nested ones included, as both finders do. */
export function countStudyNodes(nodes: readonly { children?: readonly unknown[] | null }[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countStudyNodes((node.children ?? []) as { children?: readonly unknown[] | null }[]), 0);
}
