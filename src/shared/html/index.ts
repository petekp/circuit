// Operator-summary HTML projector registry.
//
// A registration-based registry mapping flow ids to their HTML projectors.
// Flows register here at module load (via the flow catalog); the writer reads
// through the getter. This inverts the dependency so shared/html never imports
// a flow module directly. Flows without a registered projector skip HTML
// emission cleanly.

import type { HtmlProjector } from './projector.js';

export { genericCheckpointHtml } from './checkpoint-page.js';
export type {
  HtmlCheckpointChoice,
  HtmlProjector,
  HtmlProjectorCheckpoint,
  HtmlProjectorContext,
  JsonObject,
} from './projector.js';

const HTML_PROJECTORS = new Map<string, HtmlProjector>();

export function registerHtmlProjector(flowId: string, projector: HtmlProjector): void {
  HTML_PROJECTORS.set(flowId, projector);
}

export function getHtmlProjector(flowId: string): HtmlProjector | undefined {
  return HTML_PROJECTORS.get(flowId);
}
