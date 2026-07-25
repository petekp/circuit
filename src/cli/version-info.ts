// Version reporting shared by `circuit version` and the interactive shell
// header. Lives in its own leaf so the shell never has to import the router.
//
// The resolution itself lives in src/shared/engine-provenance.ts, alongside the
// engine-identity probe that stamps run records, so `circuit version` and a run
// record can never disagree about which engine is running.
export { readSourceVersion } from '../shared/engine-provenance.js';
