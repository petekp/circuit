import type { EvalCase, EvalCaseResult, EvalSourcePoolSummary, EvalSummary } from './types.ts';

type SourcePoolCase = Pick<EvalCase, 'source_run_id' | 'source_subject'>;

// Render the control verdict distribution as report.md lines. The control
// arm sends the unmutated compose, so its verdict distribution is the
// reviewer's false-positive profile: accept is the only clean outcome, and
// accept-with-fold-ins or reject means the reviewer objected to a compose
// with no planted defect. The false-positive rate is computed over the
// controls that returned a valid verdict (errors excluded), since a control
// that never produced a verdict carries no signal either way.
export function renderControlDistribution(controls: EvalSummary['controls']): string[] {
  const scored = controls.accept + controls.accept_with_fold_ins + controls.reject;
  const falsePositives = controls.accept_with_fold_ins + controls.reject;
  const rate = scored === 0 ? 'n/a' : `${((falsePositives / scored) * 100).toFixed(0)}%`;
  return [
    `Unmodified composes (no planted defect): ${controls.cases} total, ${scored} returned a valid verdict, ${controls.errors} errored.`,
    '',
    '| Reviewer verdict | Count | Reading |',
    '| --- | --- | --- |',
    `| accept | ${controls.accept} | clean — no objection to the unmutated compose |`,
    `| accept-with-fold-ins | ${controls.accept_with_fold_ins} | soft objection — apparent false positive, but absorbable |`,
    `| reject | ${controls.reject} | rejected the unmutated compose — apparent false positive |`,
    `| (errored) | ${controls.errors} | no valid verdict |`,
    '',
    `Control false-positive rate: ${rate} (accept-with-fold-ins + reject, over the ${scored} controls that returned a valid verdict).`,
    'A reject here is only a true false positive if the compose is actually clean; cross-check the groundedness certification before reading it as reviewer over-flagging.',
  ];
}

function normalizeSubject(subject: string | undefined): string {
  return subject?.replace(/\s+/g, ' ').trim() ?? '';
}

export function summarizeCaseSourcePool(cases: readonly SourcePoolCase[]): EvalSourcePoolSummary {
  const subjectBySource = new Map<string, string>();
  for (const caseDef of cases) {
    const subject = normalizeSubject(caseDef.source_subject);
    const existing = subjectBySource.get(caseDef.source_run_id);
    if (existing === undefined || existing === '') {
      subjectBySource.set(caseDef.source_run_id, subject);
    }
  }
  const subjects = Array.from(new Set([...subjectBySource.values()].filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
  return {
    source_count: subjectBySource.size,
    distinct_subjects: subjects.length,
    subjects,
  };
}

export function summarizeSourcePool(results: readonly EvalCaseResult[]): EvalSourcePoolSummary {
  return summarizeCaseSourcePool(results.map((result) => result.case));
}
