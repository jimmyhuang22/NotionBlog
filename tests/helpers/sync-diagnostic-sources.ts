/** Current diagnostic implementation only. These hashes do not grant capture
 * compatibility; every historical transition must still reject these bytes. */
export const syncDiagnosticSources: Record<string, string> = {
  "scripts/website-sync/cli.ts": "a248c7f8d4d80810741b223fecc0619964e1db38f98a585908e47f031dc25dbe",
  "scripts/website-sync/download.ts": "ec653235169816b5e8067216ba8e364a29b1f9e7659bc180b9d0a07f3e71c7c3",
  "scripts/website-sync/finalize-run.ts": "ae652e14e638651af3c3a4efe021ea6aa403007fde300ee40e9218c932a49564",
  "scripts/website-sync/run-private.mjs": "00fcef1569b3ed2e662966deb130b9f1474908ac1b340e71e2547297b4740674",
  "scripts/website-sync/run.ts": "a5a0ce8d7fac3543840e13439834bf67aeb15c1d9ca128b4298a636e0db71187",
  "scripts/website-sync/worker.ts": "e1ae0225cc90903726139a0e13f707491d2d66032b28b454620c3a7b97d7e73d",
};
