import type { NextStep } from './envelope.js';

/**
 * AEP error codes (MEP Core 1 `error.code`, snake_case) and their default `next` hint and
 * result status. Codes shared with MEP Core 1 / MEP 1 reuse the same spelling.
 */
export const ERROR_CODES = {
  // envelope / session
  bad_request: { next: 'fix', status: 'rejected' },
  unsupported_version: { next: 'fix', status: 'rejected' },
  not_authorized: { next: 'ask_user', status: 'rejected' },
  session_expired: { next: 'ask_user', status: 'rejected' },
  session_revoked: { next: 'ask_user', status: 'rejected' },
  unknown_action: { next: 'fix', status: 'rejected' },
  id_conflict: { next: 'fix', status: 'rejected' },
  invalid_params: { next: 'fix', status: 'rejected' },
  limit_exceeded: { next: 'fix', status: 'rejected' },
  // state
  conflict: { next: 'reread', status: 'rejected' },
  not_found: { next: 'reread', status: 'rejected' },
  precondition_failed: { next: 'fix', status: 'rejected' },
  validation_failed: { next: 'fix', status: 'rejected' },
  capability_unsupported: { next: 'fix', status: 'rejected' },
  scope_violation: { next: 'ask_user', status: 'rejected' },
  // proposals / history
  proposal_stale: { next: 'reread', status: 'rejected' },
  proposal_closed: { next: 'reread', status: 'rejected' },
  undo_conflict: { next: 'reread', status: 'rejected' },
  nothing_to_undo: { next: 'none', status: 'rejected' },
  nothing_to_redo: { next: 'none', status: 'rejected' },
  // assets / jobs
  asset_not_found: { next: 'fix', status: 'rejected' },
  asset_unavailable: { next: 'reread', status: 'rejected' },
  path_rejected: { next: 'fix', status: 'rejected' },
  job_not_cancellable: { next: 'none', status: 'rejected' },
  busy: { next: 'reread', status: 'rejected' },
  // outcomes
  internal_error: { next: 'none', status: 'failed' },
  outcome_uncertain: { next: 'reconcile', status: 'indeterminate' },
} as const satisfies Record<
  string,
  { next: NextStep; status: 'rejected' | 'failed' | 'indeterminate' }
>;

export type ErrorCode = keyof typeof ERROR_CODES;
