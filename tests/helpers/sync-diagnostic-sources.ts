/** Current combined diagnostic/recovery runtime. These hashes do not grant capture
 * compatibility; every historical transition must still reject these bytes. */
export const syncDiagnosticSources: Record<string, string> = {
  "scripts/website-sync/cli.ts": "a248c7f8d4d80810741b223fecc0619964e1db38f98a585908e47f031dc25dbe",
  "scripts/website-sync/download.ts": "ec653235169816b5e8067216ba8e364a29b1f9e7659bc180b9d0a07f3e71c7c3",
  "scripts/website-sync/finalize-run.ts": "ae652e14e638651af3c3a4efe021ea6aa403007fde300ee40e9218c932a49564",
  "scripts/website-sync/run-private.mjs": "94097d3954cf59bdf2e5030cbe4a91e12305c999e34229c3b356fe0c7d4cea9d",
  "scripts/website-sync/run.ts": "f896668b5d7a9241ac53caebf8dc3f699ae98c53dd7e29c7908218f047132370",
  "scripts/website-sync/worker.ts": "e1ae0225cc90903726139a0e13f707491d2d66032b28b454620c3a7b97d7e73d",
};
