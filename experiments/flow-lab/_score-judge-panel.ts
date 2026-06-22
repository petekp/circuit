// Score the blind judge panel against the hidden A/B mapping.
//
// Arm A = base task only (un-conditioned). Arm B = base task + research context
// (conditioned). The panel saw only blinded X/Y shapes. This script joins each
// task's majority verdict (X/Y/tie) to the hidden mapping to decide, per task,
// whether the CONTEXT-CONDITIONED arm (B) was judged the better-fitted shape.
//
// "helped"  = conditioned arm B won the panel.
// "hurt"    = un-conditioned arm A won the panel.
// "tie"     = identical shapes / no majority (no signal).
//
// Deterministic. Reads _judge-pairs.json (mapping) and _judge-panel-raw.json
// (panel result). Writes _fittedness-score.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LAB = resolve('experiments/flow-lab');

interface Pair {
  taskId: string;
  contextClass: string;
  _mapping: { X: 'A' | 'B'; Y: 'A' | 'B' };
  _rawShapeA: string | null;
  _rawShapeB: string | null;
}
interface PerTask {
  taskId: string;
  contextClass: string;
  counts: { X: number; Y: number; tie: number };
  majority: string;
}

function main(): void {
  const pairs = JSON.parse(readFileSync(resolve(LAB, '_judge-pairs.json'), 'utf8')) as Pair[];
  const panelFile = JSON.parse(readFileSync(resolve(LAB, '_judge-panel-raw.json'), 'utf8')) as {
    result: { perTask: PerTask[] };
  };
  const panel = panelFile.result;

  const byTask = new Map(panel.perTask.map((t) => [t.taskId, t]));
  const rows = pairs.map((p) => {
    const t = byTask.get(p.taskId);
    if (!t) throw new Error(`no panel verdict for ${p.taskId}`);
    const majority = t.majority; // 'X' | 'Y' | 'tie' | 'split-XY'
    let winnerArm: 'A' | 'B' | 'none' = 'none';
    if (majority === 'X') winnerArm = p._mapping.X;
    else if (majority === 'Y') winnerArm = p._mapping.Y;
    let outcome: 'helped' | 'hurt' | 'tie';
    if (winnerArm === 'B') outcome = 'helped';
    else if (winnerArm === 'A') outcome = 'hurt';
    else outcome = 'tie';
    return {
      taskId: p.taskId,
      contextClass: p.contextClass,
      shapeA: p._rawShapeA,
      shapeB: p._rawShapeB,
      counts: t.counts,
      majority,
      winnerArm,
      outcome,
    };
  });

  const discriminating = rows.filter((r) => r.outcome !== 'tie');
  const helped = discriminating.filter((r) => r.outcome === 'helped');
  const hurt = discriminating.filter((r) => r.outcome === 'hurt');
  const shift = rows.filter((r) => r.contextClass === 'shift');
  const control = rows.filter((r) => r.contextClass === 'control');

  const headline = {
    discriminating_tasks: discriminating.length,
    context_helped: helped.length,
    context_hurt: hurt.length,
    ties_no_signal: rows.length - discriminating.length,
    shift_helped: shift.filter((r) => r.outcome === 'helped').map((r) => r.taskId),
    shift_hurt: shift.filter((r) => r.outcome === 'hurt').map((r) => r.taskId),
    control_helped: control.filter((r) => r.outcome === 'helped').map((r) => r.taskId),
    control_hurt: control.filter((r) => r.outcome === 'hurt').map((r) => r.taskId),
  };

  writeFileSync(
    resolve(LAB, '_fittedness-score.json'),
    `${JSON.stringify({ headline, rows }, null, 2)}\n`,
  );

  process.stderr.write(
    '\n=== FITTEDNESS SCORE (context-conditioned arm B vs un-conditioned arm A) ===\n',
  );
  for (const r of rows) {
    const verb =
      r.outcome === 'helped'
        ? 'CONTEXT HELPED'
        : r.outcome === 'hurt'
          ? 'CONTEXT HURT '
          : 'tie / no signal';
    process.stderr.write(
      `[${r.contextClass.padEnd(7)}] ${r.taskId.padEnd(22)} maj=${r.majority.padEnd(4)} winner=${String(r.winnerArm).padEnd(4)} -> ${verb}\n`,
    );
  }
  process.stderr.write('\n=== HEADLINE ===\n');
  process.stderr.write(`discriminating tasks: ${headline.discriminating_tasks}\n`);
  process.stderr.write(
    `context HELPED:        ${headline.context_helped}  ${JSON.stringify([...headline.shift_helped, ...headline.control_helped])}\n`,
  );
  process.stderr.write(
    `context HURT:          ${headline.context_hurt}  ${JSON.stringify([...headline.shift_hurt, ...headline.control_hurt])}\n`,
  );
  process.stderr.write(`ties (no signal):     ${headline.ties_no_signal}\n`);
}

main();
