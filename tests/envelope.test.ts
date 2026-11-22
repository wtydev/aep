import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_NAMES,
  ACTION_VERSION,
  CORE_PROTOCOL,
  CoreManifest,
  CoreRequest,
  CoreResult,
  CoreState,
  ERROR_CODES,
  NextStep,
  Project,
  ResultStatus,
  actionSchemaName,
} from '@wty.dev/aep-schema';

const SESSION = { protocol: 'aep/1', session: 'sess-1', workspace: 'proj-1' };

const project = {
  id: 'proj-1',
  name: 'Demo',
  tempo: [{ beat: 0, bpm: 120 }],
  meter: [{ bar: 0, numerator: 4, denominator: 4 }],
  tracks: [],
  sections: [],
  assets: [],
};

const commitParams = {
  transaction: {
    label: 'intro section',
    operations: [
      { op: 'project.update', patch: { name: 'Demo' } },
      { op: 'section.add', section: { id: 'sec-1', name: 'Intro', start: 0, duration: 4 } },
    ],
  },
};

const commitRequest = {
  ...SESSION,
  id: 'req-1',
  credential: 'capability-token',
  action: 'transaction.commit',
  version: ACTION_VERSION,
  baseRevision: 'rev-0',
  params: commitParams,
};

const succeededResult = {
  ...SESSION,
  id: 'req-1',
  status: 'succeeded',
  revision: 'rev-1',
  output: {
    transactionId: 'req-1',
    kind: 'commit',
    projectId: 'proj-1',
    baseRevision: 'rev-0',
    revision: 'rev-1',
    committedAt: '2026-11-22T00:00:00.000Z',
    client: { name: 'test', session: 'sess-1' },
    operationCount: 2,
    operations: ['project.update', 'section.add'],
    changes: [],
    created: [],
    removed: [],
    undoable: true,
  },
};

const rejectedResult = {
  ...SESSION,
  id: 'req-2',
  status: 'rejected',
  error: { code: 'scope_violation', next: 'ask_user', message: 'operation outside session scope' },
};

const indeterminateResult = {
  ...SESSION,
  id: 'req-3',
  status: 'indeterminate',
  error: { code: 'outcome_uncertain', next: 'reconcile', message: 'host did not confirm commit' },
};

const manifest = {
  ...SESSION,
  expiresAt: 1893456000000,
  stateSchema: 'schemas/project.schema.json',
  actions: ACTION_NAMES.map((name) => ({
    id: name,
    version: ACTION_VERSION,
    effect: ACTIONS[name].effect,
    paramsSchema: `schemas/${actionSchemaName(name, 'params')}.schema.json`,
    resultSchema: `schemas/${actionSchemaName(name, 'result')}.schema.json`,
  })),
};

const state = { ...SESSION, revision: 'rev-1', data: project };

describe('sample envelope documents parse', () => {
  it('CoreRequest (transaction.commit)', () => {
    expect(CoreRequest.parse(commitRequest)).toBeTruthy();
    expect(ACTIONS['transaction.commit'].params.parse(commitParams)).toBeTruthy();
  });

  it('succeeded CoreResult', () => {
    expect(CoreResult.parse(succeededResult)).toBeTruthy();
    expect(ACTIONS['transaction.commit'].output.parse(succeededResult.output)).toBeTruthy();
  });

  it('rejected CoreResult', () => {
    expect(CoreResult.parse(rejectedResult)).toBeTruthy();
  });

  it('indeterminate CoreResult', () => {
    expect(CoreResult.parse(indeterminateResult)).toBeTruthy();
  });

  it('CoreManifest (AEP actions)', () => {
    expect(CoreManifest.parse(manifest)).toBeTruthy();
  });

  it('CoreState (Project data)', () => {
    expect(CoreState.parse(state)).toBeTruthy();
    expect(Project.parse(state.data)).toBeTruthy();
  });
});

describe('envelope validation', () => {
  it('uses protocol aep/1', () => {
    expect(CORE_PROTOCOL).toBe('aep/1');
  });

  it.each([
    ['request', CoreRequest, commitRequest],
    ['result', CoreResult, rejectedResult],
    ['manifest', CoreManifest, manifest],
    ['state', CoreState, state],
  ] as const)('rejects protocol mep/core/1 in a %s', (_name, schema, doc) => {
    expect(() => schema.parse({ ...doc, protocol: 'mep/core/1' })).toThrow();
  });

  it.each([
    ['request', CoreRequest, commitRequest],
    ['result', CoreResult, rejectedResult],
    ['manifest', CoreManifest, manifest],
    ['state', CoreState, state],
  ] as const)('rejects an extra top-level field in a %s', (_name, schema, doc) => {
    expect(() => schema.parse({ ...doc, bogus: true })).toThrow();
  });

  it('rejects a succeeded result carrying error', () => {
    expect(() => CoreResult.parse({ ...succeededResult, error: rejectedResult.error })).toThrow();
  });

  it('rejects a non-succeeded result without error', () => {
    const { error: _error, ...rejectedNoError } = rejectedResult;
    expect(() => CoreResult.parse(rejectedNoError)).toThrow();
    const { error: _error2, ...indeterminateNoError } = indeterminateResult;
    expect(() => CoreResult.parse(indeterminateNoError)).toThrow();
    const { error: _error3, ...failedNoError } = { ...rejectedResult, status: 'failed' };
    expect(() => CoreResult.parse(failedNoError)).toThrow();
  });

  it('requires next=reconcile on indeterminate results', () => {
    const bad = {
      ...indeterminateResult,
      error: { ...indeterminateResult.error, next: 'reread' },
    };
    expect(() => CoreResult.parse(bad)).toThrow();
  });
});

describe('ERROR_CODES fit the envelope', () => {
  it('every next is in the NextStep enum and every status is valid', () => {
    for (const [code, def] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(NextStep.options).toContain(def.next);
      expect(ResultStatus.options).toContain(def.status);
      expect(def.status).not.toBe('succeeded');
    }
  });
});

describe('generated JSON schemas', () => {
  it('core-request.schema.json requires protocol const aep/1', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../schemas/core-request.schema.json', import.meta.url)),
        'utf8',
      ),
    ) as { properties?: { protocol?: { const?: string } } };
    expect(schema.properties?.protocol?.const).toBe('aep/1');
  });
});
