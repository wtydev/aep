/**
 * Wire envelope. AEP is a domain profile of MEP Core 1 (`mep/core/1`): every request, result,
 * manifest and state document on the wire is a valid MEP Core 1 document. AEP-specific data
 * travels only inside `params`, `output` and `state.data`. See docs/adr/0001-mep-core-compatibility.md.
 */
import { z } from 'zod';

export const CORE_PROTOCOL = 'mep/core/1' as const;

const CoreId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const ActionId = z.string().regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/);
const SchemaPath = z.string().regex(/^schemas\/[A-Za-z0-9_-]+\.schema\.json$/);

export const SessionId = CoreId;
export const WorkspaceId = CoreId;
export const RequestId = CoreId;

/** `value` if it is a valid Core id, otherwise the placeholder `'invalid'` (safe to echo). */
export const sanitizeRequestId = (value: unknown): string =>
  CoreId.safeParse(value).success ? (value as string) : 'invalid';

/** Next-step hint for the client (MEP Core 1 enum). */
export const NextStep = z.enum(['none', 'fix', 'reread', 'ask_user', 'reconcile']);
export type NextStep = z.infer<typeof NextStep>;

export const CoreRequest = z.strictObject({
  protocol: z.literal(CORE_PROTOCOL),
  session: SessionId,
  workspace: WorkspaceId,
  id: RequestId,
  credential: z.string().min(1).max(512),
  action: ActionId,
  version: z.number().int().min(1),
  baseRevision: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()),
});
export type CoreRequest = z.infer<typeof CoreRequest>;

export const CoreError = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  next: NextStep,
  message: z.string().min(1).max(1200),
});
export type CoreError = z.infer<typeof CoreError>;

export const ResultStatus = z.enum(['succeeded', 'rejected', 'failed', 'indeterminate']);
export type ResultStatus = z.infer<typeof ResultStatus>;

export const CoreResult = z
  .strictObject({
    protocol: z.literal(CORE_PROTOCOL),
    session: SessionId,
    workspace: WorkspaceId,
    id: RequestId,
    status: ResultStatus,
    revision: z.string().min(1).optional(),
    output: z.unknown().optional(),
    error: CoreError.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.status === 'succeeded') {
      if (r.revision === undefined)
        ctx.addIssue({ code: 'custom', message: 'succeeded requires revision' });
      if (!('output' in r)) ctx.addIssue({ code: 'custom', message: 'succeeded requires output' });
      if (r.error) ctx.addIssue({ code: 'custom', message: 'succeeded forbids error' });
    } else {
      if (!r.error) ctx.addIssue({ code: 'custom', message: `${r.status} requires error` });
      if ('output' in r) ctx.addIssue({ code: 'custom', message: `${r.status} forbids output` });
      if (r.status === 'indeterminate' && r.error && r.error.next !== 'reconcile')
        ctx.addIssue({ code: 'custom', message: 'indeterminate requires next=reconcile' });
    }
  });
export type CoreResult = z.infer<typeof CoreResult>;

export const ActionDeclaration = z.strictObject({
  id: ActionId,
  version: z.number().int().min(1),
  effect: z.enum(['read', 'write']),
  paramsSchema: SchemaPath,
  resultSchema: SchemaPath,
});
export type ActionDeclaration = z.infer<typeof ActionDeclaration>;

/** Session manifest (`mep.json` in the directory binding). Lists only actions this session may use. */
export const CoreManifest = z.strictObject({
  protocol: z.literal(CORE_PROTOCOL),
  session: SessionId,
  workspace: WorkspaceId,
  /** Unix epoch milliseconds. */
  expiresAt: z.number().int().min(0),
  actions: z.array(ActionDeclaration),
  stateSchema: SchemaPath,
});
export type CoreManifest = z.infer<typeof CoreManifest>;

/** Versioned state snapshot (`state.json`). For AEP, `data` is an audio `Project`. */
export const CoreState = z.strictObject({
  protocol: z.literal(CORE_PROTOCOL),
  session: SessionId,
  workspace: WorkspaceId,
  revision: z.string().min(1),
  data: z.unknown(),
});
export type CoreState = z.infer<typeof CoreState>;
