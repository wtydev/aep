import { describe, expect, it } from 'vitest';
import { AepError } from '@aep/core';
import {
  PATTERN_GENERATOR_ID,
  RENDER_MANIFEST_MEDIA_TYPE,
  referenceExecutors,
} from './fixture-executors.js';
import type { JobExecutor } from './jobs.js';
import { errorCode, makeFixture, output, renameTrack } from './test-harness.js';
import type { Fixture, Loose } from './test-harness.js';

const RENDER = { target: 'mix', format: { container: 'wav', sampleRate: 48_000 } };
const PATTERN = { pitches: [60, 64, 67], stepBeats: 0.25, count: 8 };

async function finish(f: Fixture, jobId: string): Promise<Loose> {
  await f.host.waitForJobs();
  return output(await f.reader.call('job.status', { jobId })).job;
}

describe('DoD 9: jobs', () => {
  it('render lifecycle: queued -> succeeded, asset lands in the store, project revision unchanged', async () => {
    const f = makeFixture();
    const queued = output(await f.proposer.write('render.request', RENDER)).job;
    expect(queued.state).toBe('queued');
    expect(queued.kind).toBe('render');
    expect(queued.revision).toBe('rev-0');
    expect(queued.request.target).toBe('mix');

    const done = await finish(f, queued.id);
    expect(done.state).toBe('succeeded');
    expect(done.progress).toBe(1);
    expect(done.result.assets).toHaveLength(1);
    expect(done.result.assets[0].mediaType).toBe(RENDER_MANIFEST_MEDIA_TYPE);
    expect(done.result.reproducibility.executor).toBeDefined();

    const store = output(await f.reader.call('asset.list', { store: true })).assets;
    expect(store.map((a: { id: string }) => a.id)).toEqual([done.result.assets[0].id]);
    expect(
      output(await f.reader.call('asset.list', { store: false })).assets.map(
        (a: { id: string }) => a.id,
      ),
    ).toEqual(['a-1']);
    expect(f.host.revision).toBe('rev-0');
    expect(output(await f.reader.call('history.list')).entries).toEqual([]);
  });

  it('a job can be observed running before it finishes (executors are async)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: JobExecutor = {
      kind: 'render',
      id: 'slow',
      describe: () => ({ outputs: ['audio'], deterministic: true }),
      async run(_input, ctx) {
        ctx.progress(0.5);
        await gate;
        return { assets: [] };
      },
    };
    const f = makeFixture({ executors: [slow] });
    const job = output(await f.proposer.write('render.request', RENDER)).job;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const mid = output(await f.reader.call('job.status', { jobId: job.id })).job;
    expect(mid.state).toBe('running');
    expect(mid.progress).toBe(0.5);
    release();
    expect((await finish(f, job.id)).state).toBe('succeeded');
  });

  it('cancel moves a pending job to cancelled and it stays cancelled', async () => {
    const f = makeFixture();
    const job = output(await f.proposer.write('render.request', RENDER)).job;
    const cancelled = output(await f.proposer.call('job.cancel', { jobId: job.id })).job;
    expect(cancelled.state).toBe('cancelled');
    const final = await finish(f, job.id);
    expect(final.state).toBe('cancelled');
    expect(final.result).toBeUndefined();
    expect(output(await f.reader.call('asset.list', { store: true })).assets).toEqual([]);
  });

  it('cancel aborts a running executor and discards its output', async () => {
    let sawAbort = false;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const stubborn: JobExecutor = {
      kind: 'render',
      id: 'stubborn',
      describe: () => ({ outputs: ['audio'], deterministic: false }),
      async run(_input, ctx) {
        started();
        await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r()));
        sawAbort = true;
        return { assets: [ctx.putAsset(new Uint8Array([1]), { mediaType: 'audio/wav' })] };
      },
    };
    const f = makeFixture({ executors: [stubborn] });
    const job = output(await f.proposer.write('render.request', RENDER)).job;
    await startedP;
    expect(output(await f.proposer.call('job.cancel', { jobId: job.id })).job.state).toBe(
      'cancelled',
    );
    await f.host.waitForJobs();
    expect(sawAbort).toBe(true);
    expect((await finish(f, job.id)).state).toBe('cancelled');
    expect(output(await f.reader.call('asset.list', { store: true })).assets).toEqual([]);
  });

  it('cancelling a finished job is job_not_cancellable; an unknown job is not_found', async () => {
    const f = makeFixture();
    const job = output(await f.proposer.write('render.request', RENDER)).job;
    await finish(f, job.id);
    const r = await f.proposer.call('job.cancel', { jobId: job.id });
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('job_not_cancellable');
    expect(errorCode(await f.proposer.call('job.cancel', { jobId: 'job-nope' }))).toBe('not_found');
    expect(errorCode(await f.reader.call('job.status', { jobId: 'job-nope' }))).toBe('not_found');
    expect((await finish(f, job.id)).state).toBe('succeeded');
  });

  it('generation is deterministic for the same seed and different for a different seed', async () => {
    const f = makeFixture();
    const gen = async (seed: number) => {
      const job = output(
        await f.proposer.write('generation.request', {
          generator: PATTERN_GENERATOR_ID,
          parameters: PATTERN,
          seed,
          target: { trackId: 't-midi' },
        }),
      ).job;
      return finish(f, job.id);
    };
    const a1 = await gen(7);
    const a2 = await gen(7);
    const b = await gen(8);
    for (const j of [a1, a2, b]) expect(j.state).toBe('succeeded');
    const notes = (j: Loose) => j.result.operations[0].notes;
    const strip = (n: Array<Record<string, unknown>>) => n.map(({ id: _id, ...rest }) => rest);
    expect(strip(notes(a1))).toEqual(strip(notes(a2)));
    expect(strip(notes(a1))).not.toEqual(strip(notes(b)));
    expect(a1.result.reproducibility).toMatchObject({ seed: 7, executor: PATTERN_GENERATOR_ID });
    expect(f.host.revision).toBe('rev-0');
    expect(notes(a1)).toHaveLength(8);
  });

  it('generated operations can be committed as a normal transaction', async () => {
    const f = makeFixture();
    const job = output(
      await f.proposer.write('generation.request', {
        generator: PATTERN_GENERATOR_ID,
        parameters: PATTERN,
        seed: 1,
        target: { trackId: 't-midi' },
      }),
    ).job;
    const done = await finish(f, job.id);
    const r = await f.editor.commit(done.result.operations);
    expect(r.status).toBe('succeeded');
    expect(f.host.state(f.reader.session).data.tracks[0]!.clips[0]).toMatchObject({ id: 'c-midi' });
  });

  it('generation.request validates the generator and its parameters up front', async () => {
    const f = makeFixture();
    expect(
      errorCode(
        await f.proposer.write('generation.request', { generator: 'nope', parameters: {} }),
      ),
    ).toBe('not_found');
    const bad = await f.proposer.write('generation.request', {
      generator: PATTERN_GENERATOR_ID,
      parameters: { pitches: [999], stepBeats: 0, count: 0 },
    });
    expect(errorCode(bad)).toBe('invalid_params');
    const rec = output(await f.proposer.call('receipt.get', { requestId: bad.id }));
    expect(rec.diagnostics.length).toBeGreaterThanOrEqual(3);
  });

  it('render.request can render the proposed state of a proposalId', async () => {
    const f = makeFixture();
    const p = output(
      await f.proposer.propose([
        { op: 'clip.move', clipId: 'c-midi', start: 16 },
        renameTrack('t-midi', 'Proposed'),
      ]),
    );
    const job = output(
      await f.proposer.write('render.request', { ...RENDER, proposalId: p.id }),
    ).job;
    expect(job.proposalId).toBe(p.id);
    const done = await finish(f, job.id);
    expect(done.state).toBe('succeeded');
    expect(done.proposalId).toBe(p.id);
    // the executor saw the proposed state (clip at beat 16 = 8s), not the accepted one
    const live = makeFixture();
    const liveJob = output(await live.proposer.write('render.request', RENDER)).job;
    const liveDone = await finish(live, liveJob.id);
    expect(done.result.assets[0].contentHash).not.toBe(liveDone.result.assets[0].contentHash);
    expect(f.host.revision).toBe('rev-0');
  });

  it('render.request of an unknown, rejected or stale proposal is refused', async () => {
    const f = makeFixture();
    expect(
      errorCode(await f.proposer.write('render.request', { ...RENDER, proposalId: 'nope' })),
    ).toBe('not_found');
    const p = output(await f.proposer.propose([renameTrack('t-midi', 'x')]));
    await f.editor.write('proposal.reject', { proposalId: p.id });
    expect(
      errorCode(await f.proposer.write('render.request', { ...RENDER, proposalId: p.id })),
    ).toBe('proposal_closed');
    const q = output(await f.proposer.propose([renameTrack('t-midi', 'mine')]));
    await f.editor.commit([renameTrack('t-midi', 'theirs')]);
    await f.editor.write('proposal.accept', { proposalId: q.id });
    expect(
      errorCode(await f.proposer.write('render.request', { ...RENDER, proposalId: q.id })),
    ).toBe('proposal_stale');
  });

  it('render of an accepted revision records that revision on the job', async () => {
    const f = makeFixture();
    await f.editor.commit([renameTrack('t-midi', 'x')]);
    const job = output(await f.proposer.write('render.request', RENDER)).job;
    expect(job.revision).toBe('rev-1');
  });

  it('an unknown trackId in a render request is not_found', async () => {
    const f = makeFixture();
    expect(
      errorCode(await f.proposer.write('render.request', { ...RENDER, trackIds: ['ghost'] })),
    ).toBe('not_found');
  });

  it('executor failures become a failed job with a generic message, never a stack', async () => {
    const boom: JobExecutor = {
      kind: 'render',
      id: 'boom',
      describe: () => ({ outputs: ['audio'], deterministic: false }),
      async run() {
        throw new Error('secret internal detail /Users/someone/path');
      },
    };
    const f = makeFixture({ executors: [boom] });
    const job = output(await f.proposer.write('render.request', RENDER)).job;
    const done = await finish(f, job.id);
    expect(done.state).toBe('failed');
    expect(done.error.code).toBe('internal_error');
    expect(JSON.stringify(done)).not.toContain('secret internal detail');
  });

  it('an executor throwing an AepError surfaces its code on the failed job', async () => {
    const e: JobExecutor = {
      kind: 'render',
      id: 'aep-err',
      describe: () => ({ outputs: ['audio'], deterministic: false }),
      async run() {
        throw new AepError('limit_exceeded', 'too big');
      },
    };
    const f = makeFixture({ executors: [e] });
    const job = output(await f.proposer.write('render.request', RENDER)).job;
    const done = await finish(f, job.id);
    expect(done.state).toBe('failed');
    expect(done.error).toMatchObject({ code: 'limit_exceeded' });
  });

  it('a host without executors declares no render/generation/jobs capability', async () => {
    const f = makeFixture({ executors: [] });
    expect(errorCode(await f.proposer.write('render.request', RENDER))).toBe(
      'capability_unsupported',
    );
    expect(errorCode(await f.proposer.write('generation.request', { generator: 'x' }))).toBe(
      'capability_unsupported',
    );
    const caps = output(await f.reader.call('aep.capabilities')).capabilities;
    expect(Object.keys(caps)).not.toContain('aep.render');
    expect(Object.keys(caps)).not.toContain('aep.generation');
  });

  it('aep.capabilities advertises renderers and generators from the registered executors', async () => {
    const f = makeFixture({ executors: referenceExecutors() });
    const caps = output(await f.reader.call('aep.capabilities'));
    expect(caps.generators.map((g: { id: string }) => g.id)).toEqual([PATTERN_GENERATOR_ID]);
    expect(caps.generators[0].parametersSchema.type).toBe('object');
    expect(Object.keys(caps.capabilities)).toContain('aep.render');
    expect(caps.limits.maxOperationsPerTransaction).toBeGreaterThan(0);
    expect(caps.session.role).toBe('read');
    expect(caps.aep.protocolVersion).toBe('0.1');
  });

  it('waitForJobs does not wait on a cancelled executor that ignores the signal', async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    const deaf: JobExecutor = {
      kind: 'render',
      id: 'deaf',
      describe: () => ({ outputs: ['audio'], deterministic: false }),
      async run() {
        started();
        await hung;
        return {};
      },
    };
    const f = makeFixture({ executors: [deaf] });
    const job = output(await f.proposer.write('render.request', RENDER)).job;
    await startedP;
    await f.proposer.call('job.cancel', { jobId: job.id });
    await f.host.waitForJobs(); // would hang before the fix
    expect((await finish(f, job.id)).state).toBe('cancelled');
    release();
  });

  it('an executor AepError message is not copied onto the job (it may hold host paths)', async () => {
    const e: JobExecutor = {
      kind: 'render',
      id: 'leaky',
      describe: () => ({ outputs: ['audio'], deterministic: false }),
      async run() {
        throw new AepError('limit_exceeded', 'cannot write /Users/someone/secret/out.wav');
      },
    };
    const f = makeFixture({ executors: [e] });
    const job = output(await f.proposer.write('render.request', RENDER)).job;
    const done = await finish(f, job.id);
    expect(done.error.code).toBe('limit_exceeded');
    expect(JSON.stringify(done)).not.toContain('/Users/someone');
  });
});
