import { PursuitContract } from '../reports.js';
import type { PursuitTouchSet } from '../reports.js';

const DEFAULT_CHECK_IN_TRIGGERS = [
  'The work requires a product or design decision that is not implied by the goal.',
  'The likely change crosses a high-risk boundary or irreversible operation.',
  'The requested proof cannot be discovered from the project.',
  'The implementation would require parallel code writes, which Pursuits V1 blocks.',
];

export type PursuitContractProjectorInputs = {
  readonly goal: string;
  readonly verificationCommands: ReadonlyArray<
    PursuitContract['verification_command_candidates'][number]
  >;
};

function slugFor(index: number): string {
  return `pursuit-${index + 1}`;
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim();
}

// Recognize an operator's inline enumeration — "(1) do X (2) do Y", "1) X 2) Y",
// or "1. X 2. Y" — as a deliberate list of distinct ideas. The markers must be
// whitespace-bounded (so file names like "file1.ts" and versions like "1.0" do
// not match) and form a sequential run 1, 2, 3, … starting at 1 (so an
// incidental single "2)" does not trigger a split). Without this, a single-line
// enumerated goal collapsed into one pursuit — the F12 fan-out finding.
function splitInlineEnumeration(goal: string): string[] {
  const markerRe = /(?:^|\s)\(?(\d+)[.)](?=\s|$)/g;
  const markers: { readonly start: number; readonly end: number; readonly num: number }[] = [];
  let match: RegExpExecArray | null = markerRe.exec(goal);
  while (match !== null) {
    markers.push({ start: match.index, end: markerRe.lastIndex, num: Number(match[1]) });
    match = markerRe.exec(goal);
  }
  if (markers.length < 2) return [];
  if (markers.some((marker, index) => marker.num !== index + 1)) return [];

  const segments: string[] = [];
  for (const [index, marker] of markers.entries()) {
    const nextMarker = markers[index + 1];
    const textEnd = nextMarker === undefined ? goal.length : nextMarker.start;
    const segment = goal
      .slice(marker.end, textEnd)
      .trim()
      .replace(/[,;.]+$/, '')
      .trim();
    if (segment.length > 0) segments.push(segment);
  }
  return segments.length > 1 ? segments : [];
}

function splitPursuits(goal: string): string[] {
  const lines = goal
    .split(/\r?\n/)
    .map((line) => stripListMarker(line))
    .filter((line) => line.length > 0);
  if (lines.length > 1) return lines;

  const inline = splitInlineEnumeration(goal);
  if (inline.length > 1) return inline;

  const semicolonParts = goal
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return semicolonParts.length > 1 ? semicolonParts : [goal.trim()];
}

function estimatedTouchSet(text: string): PursuitTouchSet {
  const pathMatches = text.match(
    /(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|json|md|mjs|cjs|css|html|yml|yaml)/g,
  );
  const commandMatches = text.match(/\bnpm run [a-z0-9:-]+\b/gi);
  const generatedOutputs = (pathMatches ?? []).filter(
    (path) =>
      path.startsWith('generated/') ||
      path.startsWith('plugins/') ||
      path.includes('/generated/') ||
      path.includes('/plugins/'),
  );
  return {
    paths: [...new Set(pathMatches ?? [])],
    symbols: [],
    commands: [...new Set(commandMatches ?? [])],
    generated_outputs: [...new Set(generatedOutputs)],
  };
}

function riskFor(touchSet: PursuitTouchSet, text: string): 'low' | 'medium' | 'high' {
  if (touchSet.generated_outputs.length > 0) return 'high';
  if (/\b(convert|rewrite|schema|runtime|auth|security|delete|remove)\b/i.test(text)) {
    return 'high';
  }
  if (
    touchSet.paths.length > 1 ||
    /\b(refactor|integration|flow|route|verification)\b/i.test(text)
  ) {
    return 'medium';
  }
  return 'low';
}

export function projectPursuitContract(inputs: PursuitContractProjectorInputs): PursuitContract {
  const goal = inputs.goal.trim();
  const pursuits = splitPursuits(goal).map((item, index) => {
    const touchSet = estimatedTouchSet(item);
    return {
      id: slugFor(index),
      title: item.length > 80 ? `${item.slice(0, 77)}...` : item,
      goal: item,
      scope: item,
      assumptions: [
        'Circuit may gather context and execute engineering work inside the declared scope.',
        'Code-changing work is serialized in Pursuits V1 even when discovery can run in parallel.',
      ],
      estimated_touch_set: touchSet,
      proof_plan: [
        'Use project-discovered verification commands rather than assuming a fixed script exists.',
        'Record actual files and evidence after the implementation batch runs.',
      ],
      check_in_triggers: DEFAULT_CHECK_IN_TRIGGERS,
      rollback_notes: [
        'Stop and report rather than apply parallel writes.',
        'Use the final actual touch set and git diff to recover any partial change.',
      ],
      risk: riskFor(touchSet, item),
    };
  });

  return PursuitContract.parse({
    objective: goal,
    pursuits,
    execution_policy: {
      code_writes: 'serial-only',
      read_only_parallelism: 'allowed',
      parallel_write_status: 'blocked-until-safe-apply',
    },
    verification_command_candidates: inputs.verificationCommands,
  });
}
