import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_NAMES,
  ACTION_VERSION,
  CoreManifest,
  CoreRequest,
  CoreResult,
  CoreState,
  ERROR_CODES,
  Project,
  actionSchemaName,
} from '@aep/schema';
import { validate } from './helpers/mini-json-schema.js';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/mep-core/core.schema.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown>;

const MEP_NEXT = ['none', 'fix', 'reread', 'ask_user', 'reconcile'];
const SESSION = { protocol: 'mep/core/1', session: 'sess-1', workspace: 'proj-1' };

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

const cases: [string, unknown, () => void][] = [
  [
    'CoreRequest (transaction.commit)',
    commitRequest,
    () => {
      expect(CoreRequest.parse(commitRequest)).toBeTruthy();
      expect(ACTIONS['transaction.commit'].params.parse(commitParams)).toBeTruthy();
    },
  ],
  [
    'succeeded CoreResult',
    succeededResult,
    () => {
      expect(CoreResult.parse(succeededResult)).toBeTruthy();
      expect(ACTIONS['transaction.commit'].output.parse(succeededResult.output)).toBeTruthy();
    },
  ],
  [
    'rejected CoreResult',
    rejectedResult,
    () => expect(CoreResult.parse(rejectedResult)).toBeTruthy(),
  ],
  [
    'indeterminate CoreResult',
    indeterminateResult,
    () => expect(CoreResult.parse(indeterminateResult)).toBeTruthy(),
  ],
  ['CoreManifest (AEP actions)', manifest, () => expect(CoreManifest.parse(manifest)).toBeTruthy()],
  [
    'CoreState (Project data)',
    state,
    () => {
      expect(CoreState.parse(state)).toBeTruthy();
      expect(Project.parse(state.data)).toBeTruthy();
    },
  ],
];

describe('AEP documents are valid MEP Core 1 documents', () => {
  for (const [name, doc, parseZod] of cases) {
    it(name, () => {
      expect(validate(fixture, doc)).toEqual([]);
      parseZod();
    });
  }

  it('rejects an extra top-level field', () => {
    expect(validate(fixture, { ...commitRequest, bogus: true }).length).toBeGreaterThan(0);
  });

  it('rejects a rejected result without error', () => {
    const { error: _error, ...rest } = rejectedResult;
    expect(validate(fixture, rest).length).toBeGreaterThan(0);
    expect(() => CoreResult.parse(rest)).toThrow();
  });

  it('rejects a succeeded result carrying error', () => {
    const bad = { ...succeededResult, error: rejectedResult.error };
    expect(validate(fixture, bad).length).toBeGreaterThan(0);
  });
});

describe('AEP error codes fit MEP Core 1', () => {
  const defs = fixture.$defs as Record<
    string,
    {
      properties?: Record<
        string,
        { enum?: string[]; properties?: Record<string, { enum?: string[] }> }
      >;
    }
  >;
  const nextEnum = defs.error?.properties?.next?.enum ?? [];

  it('every ERROR_CODES next is in the MEP next enum', () => {
    for (const [code, def] of Object.entries(ERROR_CODES)) {
      expect(MEP_NEXT).toContain(def.next);
      expect(nextEnum).toContain(def.next);
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
