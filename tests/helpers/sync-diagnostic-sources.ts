/** Current combined diagnostic/recovery runtime. These hashes do not grant capture
 * compatibility; every historical transition must still reject these bytes. */
export const syncDiagnosticSources: Record<string, string> = {
  "scripts/website-sync/cli.ts": "a248c7f8d4d80810741b223fecc0619964e1db38f98a585908e47f031dc25dbe",
  "scripts/website-sync/download.ts": "ec653235169816b5e8067216ba8e364a29b1f9e7659bc180b9d0a07f3e71c7c3",
  "scripts/website-sync/finalize-run.ts": "ae652e14e638651af3c3a4efe021ea6aa403007fde300ee40e9218c932a49564",
  "scripts/website-sync/run-private.mjs": "d3fb87d4a114e27ba52553f79c57a5903627f57659aef392b260aa005695a99f",
  "scripts/website-sync/run.ts": "f2940cbd2f1dc190443d5da71a1ff542fb2dbca337525cabbc0c6378b24d1e52",
  "scripts/website-sync/worker.ts": "e1ae0225cc90903726139a0e13f707491d2d66032b28b454620c3a7b97d7e73d",
};
