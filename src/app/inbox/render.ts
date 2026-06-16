// Decision inbox renderer (read model).
//
// Turns the triaged inbox into a plain-English list an operator can scan. Each
// row shows the run's goal, the fork it is waiting on (the checkpoint prompt
// and the choices it offers), a best-effort staleness line, and the existing
// per-run resume command to answer it. Short sentences, one idea each.

import type { StalenessFacts } from '../continuity/brief.js';
import type { DecisionInbox, DecisionInboxRow } from './discover.js';

/**
 * A one-line staleness summary for a row, or undefined when there is nothing
 * trustworthy to say. Mirrors the handoff brief's discipline: only claim a fact
 * the probe positively established, and stay silent otherwise. This is best
 * effort — when no captured baseline was available the whole signal is absent.
 */
function stalenessLine(staleness: StalenessFacts | undefined): string | undefined {
  if (staleness === undefined || Object.keys(staleness).length === 0) return undefined;
  const parts: string[] = [];
  if (staleness.branch_gone === true) {
    parts.push(
      staleness.capture_head_reachable === true
        ? 'its branch is merged and gone'
        : 'its branch is gone',
    );
  }
  if (staleness.commits_since !== undefined && staleness.commits_since > 0) {
    const n = staleness.commits_since;
    parts.push(`${n} commit${n === 1 ? '' : 's'} landed since it parked`);
  } else if (staleness.head_advanced === true) {
    parts.push('the repo moved since it parked');
  } else if (
    staleness.head_advanced === false &&
    staleness.tree_clean === true &&
    staleness.branch_gone !== true
  ) {
    parts.push('the repo has not moved since it parked');
  }
  if (parts.length === 0) return undefined;
  return `Staleness: ${parts.join('; ')}.`;
}

function renderRow(row: DecisionInboxRow, index: number): string {
  const lines: string[] = [];
  lines.push(`${index + 1}. ${row.goal}`);
  lines.push(`   Flow: ${row.flow_id}  Run: ${row.run_id}`);
  lines.push(`   Folder: ${row.run_folder}`);
  if (row.checkpoint.prompt !== undefined) {
    lines.push(`   Asking: ${row.checkpoint.prompt}`);
  }
  const choices = row.checkpoint.choices
    .map((choice) => (choice.label === choice.id ? choice.id : `${choice.id} (${choice.label})`))
    .join(', ');
  lines.push(`   Choices: ${choices}`);
  const staleness = stalenessLine(row.staleness);
  if (staleness !== undefined) lines.push(`   ${staleness}`);
  lines.push(`   Resume: ${row.resume_command}`);
  return lines.join('\n');
}

/** Render the whole inbox as a printable, plain-English list. */
export function renderDecisionInbox(inbox: DecisionInbox): string {
  if (inbox.rows.length === 0) {
    return 'No runs are waiting on a decision.';
  }
  const count = inbox.rows.length;
  const header = `${count} run${count === 1 ? '' : 's'} waiting on a decision:`;
  const body = inbox.rows.map((row, index) => renderRow(row, index)).join('\n\n');
  return `${header}\n\n${body}`;
}
