/**
 * Items that follow one another under the same heading, in the order given: the heading is taken from
 * the first item of each run, and a key that comes back later starts a new run rather than joining the
 * earlier one (the lists are already sorted; an out-of-order item keeps its place). Years, months and
 * "日期未记录" groups in the lists are all built this way.
 */
export function runsBy<T, H extends { key: string }>(items: readonly T[], headOf: (item: T) => H): (H & { items: T[] })[] {
  const runs: (H & { items: T[] })[] = [];
  for (const item of items) {
    const head = headOf(item);
    const last = runs.at(-1);
    if (last && last.key === head.key) last.items.push(item);
    else runs.push({ ...head, items: [item] });
  }
  return runs;
}
