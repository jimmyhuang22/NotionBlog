/** Current combined diagnostic/recovery runtime. These hashes do not grant capture
 * compatibility; every historical transition must still reject these bytes. */
export const syncDiagnosticSources: Record<string, string> = {
  "scripts/website-sync/cli.ts": "43bc43b353e8df9e54a0ce4290bd680f59962af79b91718e1d9c03448217f437",
  "scripts/website-sync/download.ts": "c200efd3effc0c8daa54fe44d30cab0a9d2d54ade556f6e95fac52789f7fa5dc",
  "scripts/website-sync/finalize-run.ts": "ae652e14e638651af3c3a4efe021ea6aa403007fde300ee40e9218c932a49564",
  "scripts/website-sync/run-private.mjs": "6843f4a8c29b9977a9d8625792973ecf950377037fa4053bbe82a6d93eb6ec41",
  "scripts/website-sync/run.ts": "bda4cb6557361df1f83bc75e4a248012fe05e40b4c0ebd0ecb7a1dfc7ef54994",
  "scripts/website-sync/worker.ts": "97f5fb9af41ee0018df2ac0bb65f262ed34d26956bd6c4a07b6873dd12e90ba6",
};
