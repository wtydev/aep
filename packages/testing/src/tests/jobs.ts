/**
 * Level `jobs`: asynchronous render and generation jobs. The tests only rely on the job
 * lifecycle and on structural properties of results, so a host with a real renderer passes too.
 */
import type { Loose, TestContext } from '../context.js';
import { op } from '../ops.js';
import { defineLevel } from './define.js';

const t = defineLevel('jobs');
const RENDER = ['aep.render', 'aep.jobs'];
const GENERATE = ['aep.generation', 'aep.jobs'];
const PATTERN = 'aep.reference.pattern';
const WAV = { container: 'wav' };
const PARAMS = { pitches: [60, 64, 67], stepBeats: 0.5, count: 6 };

const TERMINAL = ['succeeded', 'failed', 'cancelled'];

function requirePattern(ctx: TestContext, caps: Loose): void {
  if (!caps.generators.some((g: Loose) => g.id === PATTERN)) {
    ctx.skip(`host offers no '${PATTERN}' generator (reference executors not enabled)`);
  }
}

async function generate(ctx: TestContext, seed: number, extra: Loose = {}): Promise<Loose> {
  const { job } = await ctx.callOk('generation.request', {
    generator: PATTERN,
    parameters: { ...PARAMS, ...extra },
    seed,
  });
  const done = await ctx.waitForJob(job.id);
  ctx.equal(done.state, 'succeeded', `generation job state (${JSON.stringify(done.error ?? '')})`);
  return done;
}

export const jobTests = [
  t(
    'render-lifecycle',
    'render.request returns a job that reaches succeeded with assets in the host store',
    async (ctx) => {
      const base = await ctx.inspect();
      const { job } = await ctx.callOk('render.request', { target: 'mix', format: WAV });
      ctx.equal(job.kind, 'render', 'kind');
      ctx.assert(
        ['queued', 'running', 'succeeded'].includes(job.state),
        `initial state ${job.state}`,
      );
      ctx.equal(job.revision, base.revision, 'job is bound to the revision at request time');
      const done = await ctx.waitForJob(job.id);
      ctx.equal(done.state, 'succeeded', `final state (${JSON.stringify(done.error ?? '')})`);
      ctx.assert(
        done.result && done.result.assets.length >= 1,
        'a render produces at least one asset',
      );
      const asset = done.result.assets[0];
      ctx.equal(asset.availability, 'available', 'asset availability');
      const store = await ctx.callOk('asset.list', { store: true });
      ctx.assert(
        store.assets.some((a: Loose) => a.id === asset.id),
        'render asset missing from the host store',
      );
      ctx.assert(
        !(await ctx.project()).assets.some((a: Loose) => a.id === asset.id),
        'render asset must not be in the project',
      );
      await ctx.expectUnchanged(base, 'after render');
    },
    { requires: RENDER },
  ),

  t(
    'render-bound-to-revision',
    'a render reflects the revision it was requested at, not later edits',
    async (ctx) => {
      const base = await ctx.revision();
      const { job } = await ctx.callOk('render.request', { target: 'mix', format: WAV });
      await ctx.commitOk([op.renameTrack('t-midi', 'Later')]);
      const done = await ctx.waitForJob(job.id);
      ctx.equal(done.revision, base, 'job revision');
      ctx.equal(done.state, 'succeeded', 'state');
    },
    { requires: RENDER },
  ),

  t(
    'render-params',
    'render parameters are validated',
    async (ctx) => {
      ctx.expectError(
        await ctx.call('render.request', { target: 'mix', format: { container: 'WAV!' } }),
        'invalid_params',
      );
      ctx.expectError(
        await ctx.call('render.request', { target: 'everything', format: WAV }),
        'invalid_params',
      );
      ctx.expectError(await ctx.call('render.request', { format: WAV }), 'invalid_params');
    },
    { requires: RENDER },
  ),

  t(
    'render-replay',
    'replaying a render request id returns the same job',
    async (ctx) => {
      const id = ctx.uid('render');
      const base = await ctx.revision();
      const first = await ctx.call('render.request', { target: 'mix', format: WAV }, { id, base });
      const second = await ctx.call('render.request', { target: 'mix', format: WAV }, { id, base });
      ctx.same(second, first, 'replayed render.request');
    },
    { requires: RENDER },
  ),

  t(
    'render-proposal',
    'render.request can render the proposed state of an open proposal',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'Previewed')]);
      const { job } = await ctx.callOk('render.request', {
        target: 'mix',
        format: WAV,
        proposalId: p.id,
      });
      ctx.equal(job.proposalId, p.id, 'job proposalId');
      const done = await ctx.waitForJob(job.id);
      ctx.equal(done.state, 'succeeded', 'state');
      ctx.expectError(
        await ctx.call('render.request', { target: 'mix', format: WAV, proposalId: 'nope' }),
        'not_found',
      );
      ctx.equal(ctx.track(await ctx.project(), 't-midi').name, 'Keys', 'the project is untouched');
    },
    { requires: [...RENDER, 'aep.proposals'] },
  ),

  t(
    'status-unknown',
    'job.status and job.cancel on an unknown job are not_found',
    async (ctx) => {
      ctx.expectError(await ctx.call('job.status', { jobId: 'no-such-job' }), 'not_found');
      ctx.expectError(await ctx.call('job.cancel', { jobId: 'no-such-job' }), 'not_found');
    },
    { requires: ['aep.jobs'] },
  ),

  t(
    'cancel',
    'a job can be cancelled, or reports job_not_cancellable if it already finished',
    async (ctx) => {
      const { job } = await ctx.callOk('render.request', { target: 'mix', format: WAV });
      const r = await ctx.call('job.cancel', { jobId: job.id });
      if (r.status === 'succeeded') {
        ctx.equal((r.output as Loose).job.state, 'cancelled', 'state after cancel');
        const done = await ctx.waitForJob(job.id);
        ctx.equal(done.state, 'cancelled', 'a cancelled job stays cancelled');
      } else {
        ctx.expectError(r, 'job_not_cancellable', { next: 'none' });
      }
    },
    { requires: RENDER },
  ),

  t(
    'cancel-finished',
    'cancelling a finished job gives job_not_cancellable',
    async (ctx) => {
      const { job } = await ctx.callOk('render.request', { target: 'mix', format: WAV });
      const done = await ctx.waitForJob(job.id);
      ctx.assert(TERMINAL.includes(done.state), 'job not terminal');
      ctx.expectError(await ctx.call('job.cancel', { jobId: job.id }), 'job_not_cancellable', {
        next: 'none',
      });
      ctx.equal(
        (await ctx.callOk('job.status', { jobId: job.id })).job.state,
        done.state,
        'state unchanged',
      );
    },
    { requires: RENDER },
  ),

  t(
    'cancel-needs-propose-role',
    'a read session cannot cancel jobs',
    async (ctx) => {
      const { job } = await ctx.callOk(
        'render.request',
        { target: 'mix', format: WAV },
        { client: 0 },
      );
      ctx.expectError(
        await ctx.call('job.cancel', { jobId: job.id }, { client: 1 }),
        'not_authorized',
      );
      ctx.equal(
        (await ctx.call('job.status', { jobId: job.id }, { client: 1 })).status,
        'succeeded',
        'read session can poll',
      );
    },
    { requires: RENDER, sessions: [{ role: 'propose' }, { role: 'read' }] },
  ),

  t(
    'generation-deterministic',
    'generation with the same seed and parameters yields identical operations',
    async (ctx) => {
      requirePattern(ctx, await ctx.callOk('aep.capabilities'));
      const a = await generate(ctx, 7);
      const b = await generate(ctx, 7);
      ctx.assert(a.result.operations?.length >= 1, 'generation returned no operations');
      ctx.same(a.result.operations, b.result.operations, 'operations for the same seed');
      const c = await generate(ctx, 8);
      ctx.differs(a.result.operations, c.result.operations, 'operations for a different seed');
      ctx.assert(a.result.reproducibility !== undefined, 'reproducibility metadata');
    },
    { requires: GENERATE },
  ),

  t(
    'generation-committable',
    'generated operations are valid transactions and can be committed',
    async (ctx) => {
      requirePattern(ctx, await ctx.callOk('aep.capabilities'));
      const done = await generate(ctx, 1);
      const ops = done.result.operations;
      const v = ctx.ok(await ctx.validate(ops), 'validate generated operations');
      ctx.equal(v.valid, true, `valid (${JSON.stringify(v.diagnostics)})`);
      const rc = await ctx.commitOk(ops, { label: 'generated' });
      ctx.equal(rc.kind, 'commit', 'kind');
      const notes = ctx.clip(await ctx.project(), 'c-midi').notes.length;
      ctx.equal(notes, 8 + PARAMS.count, 'notes after committing the generated operations');
    },
    { requires: GENERATE },
  ),

  t(
    'generation-no-side-effects',
    'a generation job never changes the project',
    async (ctx) => {
      requirePattern(ctx, await ctx.callOk('aep.capabilities'));
      const before = await ctx.inspect();
      await generate(ctx, 3);
      await ctx.expectUnchanged(before, 'after generation');
    },
    { requires: GENERATE },
  ),

  t(
    'generation-unknown-generator',
    'an unknown generator or invalid generator parameters are rejected',
    async (ctx) => {
      ctx.expectError(
        await ctx.call('generation.request', { generator: 'no.such.generator', parameters: {} }),
        ['invalid_params', 'not_found'],
      );
      requirePattern(ctx, await ctx.callOk('aep.capabilities'));
      ctx.expectError(
        await ctx.call('generation.request', {
          generator: PATTERN,
          parameters: { pitches: 'C4', stepBeats: -1 },
        }),
        'invalid_params',
      );
    },
    { requires: GENERATE },
  ),

  t(
    'generation-needs-propose-role',
    'a read session cannot request generation or rendering',
    async (ctx) => {
      ctx.expectError(
        await ctx.call('generation.request', { generator: PATTERN, parameters: PARAMS }),
        'not_authorized',
      );
      ctx.expectError(
        await ctx.call('render.request', { target: 'mix', format: WAV }),
        'not_authorized',
      );
    },
    { requires: ['aep.jobs'], sessions: [{ role: 'read' }] },
  ),
];
