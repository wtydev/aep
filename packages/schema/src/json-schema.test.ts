import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { CORE_PROTOCOL, CoreResult } from './envelope.js';
import { buildJsonSchemas } from './json-schema.js';

const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(buildJsonSchemas()['core-result']!);

const base = { protocol: CORE_PROTOCOL, session: 's-1', workspace: 'w-1', id: 'r-1' };
const error = (next: string) => ({ code: 'internal_error', next, message: 'x' });

/** Each case: [label, result, valid]. The published schema must agree with the Zod schema. */
const CASES: [string, Record<string, unknown>, boolean][] = [
  ['succeeded', { ...base, status: 'succeeded', revision: 'rev-1', output: {} }, true],
  ['succeeded without revision', { ...base, status: 'succeeded', output: {} }, false],
  ['succeeded without output', { ...base, status: 'succeeded', revision: 'rev-1' }, false],
  [
    'succeeded with error',
    { ...base, status: 'succeeded', revision: 'rev-1', output: {}, error: error('fix') },
    false,
  ],
  ['rejected', { ...base, status: 'rejected', error: error('fix') }, true],
  ['rejected without error', { ...base, status: 'rejected' }, false],
  ['failed with output', { ...base, status: 'failed', error: error('none'), output: {} }, false],
  ['indeterminate', { ...base, status: 'indeterminate', error: error('reconcile') }, true],
  ['indeterminate with next=fix', { ...base, status: 'indeterminate', error: error('fix') }, false],
];

describe('published core-result JSON Schema', () => {
  it.each(CASES)('%s', (_label, result, valid) => {
    expect(CoreResult.safeParse(result).success).toBe(valid);
    expect(validate(result)).toBe(valid);
  });
});
