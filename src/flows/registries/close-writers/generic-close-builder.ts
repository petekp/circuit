// Engine-built-in generic close builder, keyed by the generic flow.result@v1
// contract.
//
// Default-OFF for the eight shipped flows: each of them aliases flow.result@v1 to
// its own family result (fix.result@v1, build.result@v1, …) in its
// contract_aliases, so a shipped flow's close resolves to its FAMILY builder and
// never reaches this one. This builder is only ever hit by a COMPOSED flow whose
// terminal close the composer left at the generic flow.result@v1 — which it does
// exactly when the family close builder's REQUIRED reads are not all producible by
// the composed topology (a triage that closes after diagnose can never satisfy
// fix.result@v1's change/verification/regression reads). Binding the family result
// there would abort the run at close time (resolveCloseReadPaths throws on the
// first unproduced required read); falling back to this generic lets the flow run
// to @complete and report the evidence it DID produce.
//
// It is reads-agnostic: it declares no required reads, so the compose executor
// passes it an empty inputs map and the required-read resolver enforces nothing.
// It folds whatever the terminal close already reads — the composer's
// evidence-soak set — into evidence_links straight off the runtime-indexed step.

import { FLOW_RESULT_CONTRACT } from '../../../schemas/builtin-report-schemas.js';
import type { CloseBuilder } from './types.js';

export const GENERIC_CLOSE_BUILDER: CloseBuilder = {
  resultSchemaName: FLOW_RESULT_CONTRACT,
  reads: [],
  build(context) {
    const evidenceLinks = [...context.closeStep.reads];
    const linkCount = evidenceLinks.length;
    return {
      schema_version: 1,
      summary:
        linkCount === 0
          ? `Composed flow '${context.flow.id}' closed with no upstream evidence.`
          : `Composed flow '${context.flow.id}' closed with ${linkCount} evidence link${
              linkCount === 1 ? '' : 's'
            }.`,
      // INFORMATIONAL ONLY. The run's honest outcome is derived from the terminal
      // ROUTE (@complete/@stop/@handoff), not from this body. The close-time bind
      // is derived from a flow declaring a primary result, so run-close DOES read
      // this field on a composed flow that points its primary result here — but the
      // bind only ever downgrades, and 'complete' maps to no downgrade, so a
      // hardcoded word cannot manufacture a green run it did not earn. This builder
      // only sits on the @complete close compose step, so 'complete' is faithful
      // here. Anything that makes this word VARY must re-derive it from real
      // upstream state: the moment it can say something other than 'complete' it is
      // load-bearing, and a wrong word here would misreport the run.
      outcome: 'complete',
      evidence_links: evidenceLinks,
    };
  },
};
