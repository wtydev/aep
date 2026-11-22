import { ERROR_CODES } from '@aep/schema';
import type { CoreError, Diagnostic, ErrorCode, NextStep, ResultStatus } from '@aep/schema';

/** Maximum MEP Core error message length, in code points. */
export const MAX_MESSAGE_CODE_POINTS = 1200;

/** Truncate a message to the MEP Core limit without splitting a code point. */
export const clampMessage = (m: string): string =>
  [...m].slice(0, MAX_MESSAGE_CODE_POINTS).join('');

/**
 * SDK error carrying an AEP `ErrorCode`. `status` and `next` are derived from `ERROR_CODES`
 * in @aep/schema so producers cannot pick an inconsistent hint.
 */
export class AepError extends Error {
  readonly code: ErrorCode;
  readonly diagnostics: Diagnostic[];
  readonly status: ResultStatus;
  readonly next: NextStep;

  constructor(code: ErrorCode, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'AepError';
    this.code = code;
    this.diagnostics = diagnostics;
    const meta = ERROR_CODES[code];
    this.status = meta.status;
    this.next = meta.next;
  }

  /** MEP Core error object. Message is truncated to 1200 code points per the schema limit. */
  toCoreError(): CoreError {
    const message = clampMessage(this.message) || this.code;
    return { code: this.code, next: this.next, message };
  }
}

export function isAepError(e: unknown): e is AepError {
  return e instanceof AepError;
}
