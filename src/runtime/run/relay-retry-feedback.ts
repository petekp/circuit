import type { AcceptanceRetryFeedback } from '../acceptance-criteria.js';

export type RelayRetryFeedback =
  | ({ readonly kind: 'acceptance_criteria' } & AcceptanceRetryFeedback)
  | {
      readonly kind: 'response_validation';
      readonly step_id: string;
      readonly report_schema: string;
      readonly reason: string;
    };

export function acceptanceCriteriaRetryFeedback(
  feedback: AcceptanceRetryFeedback,
): RelayRetryFeedback {
  return { kind: 'acceptance_criteria', ...feedback };
}

export function isRelayRetryFeedback(value: unknown): value is RelayRetryFeedback {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.step_id !== 'string' ||
    record.step_id.length === 0 ||
    typeof record.reason !== 'string' ||
    record.reason.length === 0
  ) {
    return false;
  }
  if (record.kind === 'response_validation') {
    return typeof record.report_schema === 'string' && record.report_schema.length > 0;
  }
  if (record.kind !== 'acceptance_criteria') return false;
  return (
    typeof record.criterion_id === 'string' &&
    record.criterion_id.length > 0 &&
    (record.criterion_kind === 'command' || record.criterion_kind === 'report_field')
  );
}
