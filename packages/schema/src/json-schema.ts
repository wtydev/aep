import { z } from 'zod';
import { ACTIONS, type ActionName } from './actions.js';
import { SCHEMA_VERSION } from './common.js';
import { CoreManifest, CoreRequest, CoreResult, CoreState } from './envelope.js';
import { Project } from './model.js';
import { Operation } from './operations.js';

export const SCHEMA_BASE_URI = `https://github.com/wtydev/aep/schemas/${SCHEMA_VERSION}`;

const toSchema = (schema: z.ZodType, id: string, io: 'input' | 'output' = 'input') => ({
  ...(z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Record<
    string,
    unknown
  >),
  $id: `${SCHEMA_BASE_URI}/${id}.schema.json`,
});

/** File-name-safe schema id for an action, e.g. `transaction.commit` → `transaction-commit`. */
export const actionSchemaName = (action: string, part: 'params' | 'result') =>
  `${action.replace(/\./g, '-')}-${part}`;

/**
 * The status rules `CoreResult` enforces with `superRefine`, which `z.toJSONSchema` cannot express.
 * Keep in step with `CoreResult` in envelope.ts (core spec §4).
 */
const CORE_RESULT_STATUS_RULES = [
  {
    if: { properties: { status: { const: 'succeeded' } }, required: ['status'] },
    then: { required: ['revision', 'output'], not: { required: ['error'] } },
    else: { required: ['error'], not: { required: ['output'] } },
  },
  {
    if: { properties: { status: { const: 'indeterminate' } }, required: ['status'] },
    then: {
      properties: { error: { properties: { next: { const: 'reconcile' } }, required: ['next'] } },
    },
  },
];

/**
 * All published JSON Schemas keyed by file stem. Action schemas match the `schemas/<name>.schema.json`
 * paths declared in the AEP manifest.
 */
export function buildJsonSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {
    project: toSchema(Project, 'project', 'output'),
    operation: toSchema(Operation, 'operation'),
    'core-request': toSchema(CoreRequest, 'core-request'),
    'core-result': {
      ...toSchema(CoreResult, 'core-result', 'output'),
      allOf: CORE_RESULT_STATUS_RULES,
    },
    'core-manifest': toSchema(CoreManifest, 'core-manifest'),
    'core-state': toSchema(CoreState, 'core-state', 'output'),
  };
  for (const [name, def] of Object.entries(ACTIONS) as [
    ActionName,
    (typeof ACTIONS)[ActionName],
  ][]) {
    out[actionSchemaName(name, 'params')] = toSchema(def.params, actionSchemaName(name, 'params'));
    out[actionSchemaName(name, 'result')] = toSchema(
      def.output,
      actionSchemaName(name, 'result'),
      'output',
    );
  }
  return out;
}
