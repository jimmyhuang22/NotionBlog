/** Current combined diagnostic/recovery runtime. These hashes do not grant capture
 * compatibility; every historical transition must still reject these bytes. */
export const syncDiagnosticSources: Record<string, string> = {
  "scripts/website-sync/cli.ts": "a248c7f8d4d80810741b223fecc0619964e1db38f98a585908e47f031dc25dbe",
  "scripts/website-sync/download.ts": "59c9daf54be054cbedc46d53fefc75e2edec286292599c97a140f06efe81f7c6",
  "scripts/website-sync/finalize-run.ts": "ae652e14e638651af3c3a4efe021ea6aa403007fde300ee40e9218c932a49564",
  "scripts/website-sync/run-private.mjs": "fe40de6f33b87e5078ae419a5495dc7018ec99415d1207d4f5d7f15b6a3e4f5b",
  "scripts/website-sync/run.ts": "c236f72b4e7080568998ce95d6d9719f3ff491fdf7ff564c1d6c3cc5193dadd5",
  "scripts/website-sync/worker.ts": "e1ae0225cc90903726139a0e13f707491d2d66032b28b454620c3a7b97d7e73d",
};
