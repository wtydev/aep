/**
 * AEP actions: params and outputs carried inside MEP Core 1 requests/results.
 */
import { z } from 'zod';
import { Extensions, Id, RevisionId, TimeRange } from './common.js';
import { Asset, Project } from './model.js';
import { Operation, OperationNameSchema } from './operations.js';

// ---------------------------------------------------------------- scope

/**
 * Edit scope. Every constraint present MUST hold for every change in the resulting state diff.
 * A session scope (granted by the host) and a transaction scope (self-imposed by the client)
 * are both enforced; the effective scope is their intersection.
 */
export const Scope = z.strictObject({
  /** Changes must be inside these tracks (the track entity itself or its descendants). */
  tracks: z.array(Id).min(1).optional(),
  /** Changes must be inside these clips (the clip entity itself or its descendants). */
  clips: z.array(Id).min(1).optional(),
  /** Every changed time-bearing entity must lie inside this range both before and after. */
  timeRange: TimeRange.optional(),
  /** Allowed operation names; `*` suffix wildcards allowed, e.g. `midi.notes.*`. */
  operations: z
    .array(z.string().regex(/^[a-z][a-z0-9.]*(\.\*)?$|^\*$/))
    .min(1)
    .optional(),
  /** Allowed changed properties (entity field names, or entity collection names for add/remove). */
  properties: z.array(z.string().min(1).max(64)).min(1).optional(),
});
export type Scope = z.infer<typeof Scope>;

// ---------------------------------------------------------------- changes / diff

export const EntityKind = z.enum([
  'project',
  'tempo',
  'meter',
  'trackOrder',
  'track',
  'instrument',
  'effectOrder',
  'effect',
  'clip',
  'note',
  'midiEvents',
  'automationLane',
  'section',
  'asset',
]);
export type EntityKind = z.infer<typeof EntityKind>;

/**
 * One entity-level change. `path` is an id-based entity path, e.g.
 * `/tracks/piano/clips/c1/notes/n3`. `before`/`after` hold the entity value without its child
 * collections (children are separate entities). `fields` lists changed top-level fields on update.
 */
export const Change = z.strictObject({
  path: z.string().min(1),
  entity: EntityKind,
  kind: z.enum(['add', 'remove', 'update']),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  fields: z.array(z.string()).optional(),
});
export type Change = z.infer<typeof Change>;

// ---------------------------------------------------------------- diagnostics

export const Diagnostic = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  message: z.string().max(1200),
  /** Index of the offending operation in the transaction, when applicable. */
  operationIndex: z.number().int().min(0).optional(),
  /** Entity path or JSON path of the offending value. */
  path: z.string().optional(),
});
export type Diagnostic = z.infer<typeof Diagnostic>;

// ---------------------------------------------------------------- transactions

export const Transaction = z.strictObject({
  operations: z.array(Operation).min(1),
  scope: Scope.optional(),
  /** Human-readable label for history UIs. */
  label: z.string().max(256).optional(),
  extensions: Extensions.optional(),
});
export type Transaction = z.infer<typeof Transaction>;

export const ClientInfo = z.strictObject({ name: z.string().max(128), session: z.string() });

/** Structured receipt for a committed state change (transaction, proposal accept, undo, redo). */
export const Receipt = z.strictObject({
  /** = the MEP Core request id that produced this commit. */
  transactionId: z.string(),
  kind: z.enum(['commit', 'proposal', 'undo', 'redo']),
  projectId: Id,
  baseRevision: RevisionId,
  revision: RevisionId,
  committedAt: z.iso.datetime(),
  client: ClientInfo,
  label: z.string().optional(),
  operationCount: z.number().int().min(0),
  operations: z.array(z.string()),
  changes: z.array(Change),
  created: z.array(z.string()),
  removed: z.array(z.string()),
  undoable: z.boolean(),
  /** For proposal accepts. */
  proposalId: Id.optional(),
  /** For undo/redo: the transaction reverted or re-applied. */
  targetTransactionId: z.string().optional(),
});
export type Receipt = z.infer<typeof Receipt>;

// ---------------------------------------------------------------- proposals

export const ProposalStatus = z.enum(['open', 'accepted', 'rejected', 'stale']);
export const Proposal = z.strictObject({
  id: Id,
  status: ProposalStatus,
  baseRevision: RevisionId,
  createdAt: z.iso.datetime(),
  client: ClientInfo,
  label: z.string().optional(),
  scope: Scope.optional(),
  operations: z.array(Operation),
  changes: z.array(Change),
  /** Revision produced when accepted. */
  acceptedRevision: RevisionId.optional(),
});
export type Proposal = z.infer<typeof Proposal>;

// ---------------------------------------------------------------- history

export const HistoryEntry = z.strictObject({
  transactionId: z.string(),
  kind: z.enum(['commit', 'proposal', 'undo', 'redo']),
  baseRevision: RevisionId,
  revision: RevisionId,
  committedAt: z.iso.datetime(),
  client: ClientInfo,
  label: z.string().optional(),
  undoable: z.boolean(),
  /** Set when this entry has been reverted by a later undo. */
  undoneBy: z.string().optional(),
  targetTransactionId: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

// ---------------------------------------------------------------- jobs

export const JobState = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobState = z.infer<typeof JobState>;

export const Job = z.strictObject({
  id: Id,
  kind: z.enum(['render', 'generation']),
  state: JobState,
  /** 0..1 when known. */
  progress: z.number().min(0).max(1).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Project revision (or proposal) the job is bound to. */
  revision: RevisionId,
  proposalId: Id.optional(),
  request: z.record(z.string(), z.unknown()),
  result: z
    .strictObject({
      /** Assets placed in the host asset store; link them with `asset.link`. */
      assets: z.array(Asset).default([]),
      /** Structured content (e.g. generated notes) the client may submit as a transaction or proposal. */
      operations: z.array(Operation).optional(),
      /** Reproducibility metadata. */
      reproducibility: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  error: z.strictObject({ code: z.string(), message: z.string().max(1200) }).optional(),
});
export type Job = z.infer<typeof Job>;

export const AudioFormat = z.strictObject({
  container: z.enum(['wav', 'flac', 'mp3', 'ogg', 'aiff']).or(z.string().regex(/^[a-z0-9.-]+$/)),
  sampleRate: z.number().int().min(8000).max(768000).optional(),
  bitDepth: z.union([z.literal(16), z.literal(24), z.literal(32)]).optional(),
  channels: z.number().int().min(1).max(64).optional(),
});

export const RenderRequestParams = z.strictObject({
  target: z.enum(['mix', 'stems', 'tracks']),
  trackIds: z.array(Id).optional(),
  range: TimeRange.optional(),
  format: AudioFormat,
  preview: z.boolean().default(false),
  /** Render the proposed state of an open proposal instead of the accepted state. */
  proposalId: Id.optional(),
});
export type RenderRequestParams = z.infer<typeof RenderRequestParams>;

export const GenerationRequestParams = z.strictObject({
  /** Generator id from capabilities (`generators[].id`). */
  generator: z.string().min(1).max(128),
  /** Validated against the generator's declared parameter schema. */
  parameters: z.record(z.string(), z.unknown()).default({}),
  seed: z.number().int().optional(),
  target: z.strictObject({ trackId: Id.optional(), range: TimeRange.optional() }).optional(),
});
export type GenerationRequestParams = z.infer<typeof GenerationRequestParams>;

// ---------------------------------------------------------------- capabilities

export const CapabilityId = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/);

export const Generator = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  outputs: z.array(z.enum(['audio', 'midi', 'operations'])).min(1),
  /** JSON Schema for `parameters`. */
  parametersSchema: z.record(z.string(), z.unknown()),
  deterministic: z.boolean(),
});

export const Limits = z.strictObject({
  maxOperationsPerTransaction: z.number().int().positive(),
  maxRequestBytes: z.number().int().positive(),
  maxNotesPerClip: z.number().int().positive(),
  maxTracks: z.number().int().positive(),
  maxOpenProposals: z.number().int().positive(),
  receiptRetention: z.number().int().positive(),
});
export type Limits = z.infer<typeof Limits>;

export const CapabilitiesOutput = z.strictObject({
  aep: z.strictObject({
    /** Negotiated AEP protocol version for this session. */
    protocolVersion: z.string(),
    supportedVersions: z.array(z.string()).min(1),
    schemaVersion: z.string(),
  }),
  host: z.strictObject({ name: z.string(), version: z.string() }),
  /** Capability id → capability version and options. Only declared capabilities may be used. */
  capabilities: z.record(
    CapabilityId,
    z.strictObject({ version: z.string(), options: z.record(z.string(), z.unknown()).optional() }),
  ),
  operations: z.array(OperationNameSchema),
  trackKinds: z.array(z.string()),
  deviceTypes: z.array(z.string()),
  generators: z.array(Generator).default([]),
  limits: Limits,
  session: z.strictObject({
    role: z.enum(['read', 'propose', 'edit', 'admin']),
    scope: Scope.optional(),
    expiresAt: z.number().int(),
  }),
  extensions: Extensions.optional(),
});
export type CapabilitiesOutput = z.infer<typeof CapabilitiesOutput>;

// ---------------------------------------------------------------- action table

const empty = z.strictObject({});

export const ACTIONS = {
  'aep.capabilities': {
    effect: 'read',
    params: z.strictObject({
      /** AEP protocol versions the client supports ('MAJOR.MINOR'). Omitted = host's choice. */
      versions: z
        .array(z.string().regex(/^\d+\.\d+$/))
        .min(1)
        .max(16)
        .optional(),
    }),
    output: CapabilitiesOutput,
  },
  'project.inspect': {
    effect: 'read',
    params: z.strictObject({}),
    output: z.strictObject({ revision: RevisionId, project: Project }),
  },
  'project.describe': {
    effect: 'read',
    params: empty,
    output: z.strictObject({
      projectId: Id,
      name: z.string(),
      revision: RevisionId,
      sampleRate: z.number().optional(),
      trackCount: z.number().int(),
      clipCount: z.number().int(),
      noteCount: z.number().int(),
      assetCount: z.number().int(),
      /** End of the last clip, in seconds. */
      durationSeconds: z.number(),
      durationBeats: z.number(),
      tempo: z.array(z.unknown()),
      meter: z.array(z.unknown()),
    }),
  },
  'transaction.validate': {
    effect: 'read',
    params: z.strictObject({ transaction: Transaction }),
    output: z.strictObject({
      valid: z.boolean(),
      baseRevision: RevisionId,
      diagnostics: z.array(Diagnostic),
      changes: z.array(Change),
    }),
  },
  'transaction.commit': {
    effect: 'write',
    params: z.strictObject({ transaction: Transaction }),
    output: Receipt,
  },
  'proposal.create': {
    effect: 'write',
    params: z.strictObject({ transaction: Transaction, proposalId: Id.optional() }),
    output: Proposal,
  },
  'proposal.list': {
    effect: 'read',
    params: z.strictObject({ status: z.array(z.string()).optional() }),
    output: z.strictObject({ proposals: z.array(Proposal) }),
  },
  'proposal.get': {
    effect: 'read',
    params: z.strictObject({ proposalId: Id, includeState: z.boolean().default(false) }),
    output: z.strictObject({ proposal: Proposal, state: Project.optional() }),
  },
  'proposal.accept': {
    effect: 'write',
    params: z.strictObject({ proposalId: Id }),
    output: Receipt,
  },
  'proposal.reject': {
    effect: 'write',
    params: z.strictObject({ proposalId: Id }),
    output: Proposal,
  },
  'history.list': {
    effect: 'read',
    params: z.strictObject({ limit: z.number().int().min(1).max(1000).default(100) }),
    output: z.strictObject({
      entries: z.array(HistoryEntry),
      canUndo: z.boolean(),
      canRedo: z.boolean(),
    }),
  },
  'history.undo': {
    effect: 'write',
    params: z.strictObject({ transactionId: z.string().optional() }),
    output: Receipt,
  },
  'history.redo': { effect: 'write', params: empty, output: Receipt },
  'receipt.get': {
    effect: 'read',
    params: z.strictObject({ requestId: z.string() }),
    output: z.strictObject({
      requestId: z.string(),
      action: z.string(),
      status: z.enum(['succeeded', 'rejected', 'failed', 'indeterminate']),
      errorCode: z.string().optional(),
      diagnostics: z.array(Diagnostic),
      receipt: Receipt.optional(),
    }),
  },
  'asset.list': {
    effect: 'read',
    params: z.strictObject({ store: z.boolean().default(false) }),
    output: z.strictObject({ assets: z.array(Asset) }),
  },
  'asset.import': {
    effect: 'write',
    params: z.strictObject({
      /** Relative path inside a host-declared import root. Absolute paths and `..` are rejected. */
      path: z.string().min(1).max(1024),
      root: z.string().min(1).max(64).default('inbox'),
      mediaType: z.string().optional(),
      assetId: Id.optional(),
    }),
    output: z.strictObject({ asset: Asset }),
  },
  'render.request': {
    effect: 'write',
    params: RenderRequestParams,
    output: z.strictObject({ job: Job }),
  },
  'generation.request': {
    effect: 'write',
    params: GenerationRequestParams,
    output: z.strictObject({ job: Job }),
  },
  'job.status': {
    effect: 'read',
    params: z.strictObject({ jobId: Id }),
    output: z.strictObject({ job: Job }),
  },
  'job.cancel': {
    effect: 'write',
    params: z.strictObject({ jobId: Id }),
    output: z.strictObject({ job: Job }),
  },
} as const satisfies Record<
  string,
  { effect: 'read' | 'write'; params: z.ZodType; output: z.ZodType }
>;

export type ActionName = keyof typeof ACTIONS;
export type ActionParams<A extends ActionName> = z.input<(typeof ACTIONS)[A]['params']>;
export type ActionOutput<A extends ActionName> = z.infer<(typeof ACTIONS)[A]['output']>;
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];
/** All AEP v0.1 actions are version 1 in MEP Core terms. */
export const ACTION_VERSION = 1;

/** Write actions that do not require `baseRevision` (they never mutate project state). */
export const NO_BASE_REVISION_ACTIONS: ReadonlySet<ActionName> = new Set([
  'proposal.reject',
  'asset.import',
  'job.cancel',
]);

/** Capability each action requires. `aep.core` actions are always available. */
export const ACTION_CAPABILITY: Record<ActionName, string> = {
  'aep.capabilities': 'aep.core',
  'project.inspect': 'aep.core',
  'project.describe': 'aep.core',
  'transaction.validate': 'aep.core',
  'transaction.commit': 'aep.core',
  'receipt.get': 'aep.core',
  'proposal.create': 'aep.proposals',
  'proposal.list': 'aep.proposals',
  'proposal.get': 'aep.proposals',
  'proposal.accept': 'aep.proposals',
  'proposal.reject': 'aep.proposals',
  'history.list': 'aep.history',
  'history.undo': 'aep.history',
  'history.redo': 'aep.history',
  'asset.list': 'aep.audio.assets',
  'asset.import': 'aep.audio.assets.import',
  'render.request': 'aep.render',
  'generation.request': 'aep.generation',
  'job.status': 'aep.jobs',
  'job.cancel': 'aep.jobs',
};

/** Which session roles may call which actions (host MUST also apply its own grants). */
export const ROLE_ACTIONS: Record<
  'read' | 'propose' | 'edit' | 'admin',
  ReadonlySet<ActionName>
> = (() => {
  const read: ActionName[] = [
    'aep.capabilities',
    'project.inspect',
    'project.describe',
    'transaction.validate',
    'receipt.get',
    'proposal.list',
    'proposal.get',
    'history.list',
    'asset.list',
    'job.status',
  ];
  const propose: ActionName[] = [
    ...read,
    'proposal.create',
    'render.request',
    'generation.request',
    'job.cancel',
  ];
  const edit: ActionName[] = [
    ...propose,
    'transaction.commit',
    'proposal.accept',
    'proposal.reject',
    'history.undo',
    'history.redo',
  ];
  const admin: ActionName[] = [...edit, 'asset.import'];
  return {
    read: new Set(read),
    propose: new Set(propose),
    edit: new Set(edit),
    admin: new Set(admin),
  };
})();
