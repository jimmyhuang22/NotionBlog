import type { MomentLabel } from "../lib/format.ts";

/**
 * The words of an entry's time line, to go inside its `<time>` or span. The relative name and the
 * date are read as one phrase. The name and its dot stay together and the date stays whole, so on a
 * narrow screen the line breaks after the dot and never through the date.
 */
export function EntryMoment({ moment }: { moment: MomentLabel }) {
  if (!moment.relative) return moment.rest;
  if (!moment.rest) return <span className="entry__ago">{moment.relative}</span>;
  return moment.relative === "今天"
    ? <><span className="entry__ago">{moment.relative}</span> {moment.rest}</>
    : <><span className="entry__ago">{moment.relative}</span>{" · "}<span className="entry__day">{moment.rest}</span></>;
}
