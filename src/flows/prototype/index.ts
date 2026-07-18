import { compileFlowDefinition } from '../flow-definition.js';
import { prototypeFlowDefinition } from './flow.js';

const compiledFlowPackage = compileFlowDefinition(prototypeFlowDefinition);

export { compiledFlowPackage as prototypeCompiledFlowPackage };
// Public surface: the flow's operator-summary HTML projector. The catalog
// registers it into the shared registry; tests exercise it in isolation here.
export { prototypeCheckpointProjector } from './writers/checkpoint-html.js';
export { prototypeVariantVerificationWriter } from './writers/variant-verification.js';
export { prototypeVerificationWriter } from './writers/verification.js';
