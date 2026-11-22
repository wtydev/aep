import { describe, expect, it } from 'vitest';
import { AepError, isAepError } from './errors.js';

describe('AepError', () => {
  it('derives status and next from ERROR_CODES', () => {
    const e = new AepError('not_found', 'missing');
    expect(e.code).toBe('not_found');
    expect(e.status).toBe('rejected');
    expect(e.next).toBe('reread');
    expect(new AepError('conflict', 'x').next).toBe('reread');
    expect(new AepError('scope_violation', 'x').next).toBe('ask_user');
    expect(new AepError('internal_error', 'x').status).toBe('failed');
    expect(new AepError('outcome_uncertain', 'x').status).toBe('indeterminate');
  });

  it('carries diagnostics', () => {
    const e = new AepError('scope_violation', 'x', [
      { code: 'scope_violation', message: 'm', path: '/tracks/t1' },
    ]);
    expect(e.diagnostics).toHaveLength(1);
    expect(e.diagnostics[0]!.path).toBe('/tracks/t1');
  });

  it('toCoreError truncates messages to 1200 code points', () => {
    const long = 'x'.repeat(1500);
    const core = new AepError('invalid_params', long).toCoreError();
    expect([...core.message]).toHaveLength(1200);
    expect(core.code).toBe('invalid_params');
    expect(core.next).toBe('fix');
  });
});

describe('isAepError', () => {
  it('detects AepError instances', () => {
    expect(isAepError(new AepError('conflict', 'x'))).toBe(true);
    expect(isAepError(new Error('x'))).toBe(false);
    expect(isAepError('x')).toBe(false);
  });
});
