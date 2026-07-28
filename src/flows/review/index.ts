import { compileFlowDefinition } from '../flow-definition.js';
import { reviewFlowDefinition } from './flow.js';

const compiledFlowPackage = compileFlowDefinition(reviewFlowDefinition);

export { compiledFlowPackage as reviewCompiledFlowPackage };
export { parseReviewTarget } from './writers/intake.js';
// Public surface: the codebase split is a decision the report has to stand
// behind, so the rule that produces it is testable from outside the package.
export {
  type ReviewUnit,
  type ReviewUnitBudget,
  type ReviewUnitFile,
  packReviewUnits,
} from './writers/units.js';
export {
  projectReviewIntake,
  reviewEvidenceWarnings,
} from './writers/intake-projection.js';
export { projectReviewResult } from './writers/result-projection.js';
// Public surface: Review emits HTML only when findings or evidence caveats make
// the richer report useful.
export { reviewResultProjector } from './writers/result-html.js';
