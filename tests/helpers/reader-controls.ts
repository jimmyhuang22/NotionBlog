/** Protocol-only acknowledgements for injected/PGlite route fixtures. Actual
 * GUC application, rollback and backend reuse are tested by native/m08-deadlines. */
export function readerControlResponse(text: string): { rows: never[]; command: string } | undefined {
  if (text === "BEGIN READ ONLY") return { rows: [], command: "BEGIN" };
  if (/^SET LOCAL statement_timeout = [1-9]\d*$/.test(text)) return { rows: [], command: "SET" };
  if (text === "COMMIT" || text === "ROLLBACK") return { rows: [], command: text };
}
