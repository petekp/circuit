import { compileFlowDefinition } from '../flow-definition.js';
import { reviewFlowDefinition } from './flow.js';

const compiledFlowPackage = compileFlowDefinition(reviewFlowDefinition);

export { compiledFlowPackage as reviewCompiledFlowPackage };
// Public surface: Review emits HTML only when findings or evidence caveats make
// the richer report useful.
export { reviewResultProjector } from './writers/result-html.js';
