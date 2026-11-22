import { describe, expect, it } from 'vitest';
import { demoProject } from '../domain/fixtures.js';
import {
  errorCode,
  makeFixture,
  noteUpdate,
  output,
  renameClip,
  renameTrack,
} from './test-harness.js';

describe('DoD 2: idempotency', () => {
  it('same id + same body returns a byte-identical result and bumps the revision once', async () => {
    const { editor, host } = makeFixture();
    const req = editor.request(
      'transaction.commit',
      { transaction: { operations: [renameTrack('t-midi', 'Once')] } },
      {
        id: 'req-once',
        baseRevision: 'rev-0',
      },
    );
    const first = await host.handle(req);
    const second = await host.handle(structuredClone(req));
    const third = await host.handle(structuredClone(req));
    expect(first.status).toBe('succeeded');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    expect(host.revision).toBe('rev-1');
    const history = output(await editor.call('history.list'));
    expect(history.entries).toHaveLength(1);
  });

  it('a replay does not re-run the stale-revision check', async () => {
    const { editor, host } = makeFixture();
    const req = editor.request(
      'transaction.commit',
      { transaction: { operations: [renameTrack('t-midi', 'A')] } },
      {
        id: 'req-a',
        baseRevision: 'rev-0',
      },
    );
    const first = await host.handle(req);
    await editor.commit([renameTrack('t-audio', 'B')]); // rev-2
    const replay = await host.handle(structuredClone(req));
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(host.revision).toBe('rev-2');
  });

  it('same id + different body is id_conflict and changes nothing', async () => {
    const { editor, host } = makeFixture();
    const a = await editor.commit([renameTrack('t-midi', 'A')], {}, { id: 'req-same' });
    expect(a.status).toBe('succeeded');
    const b = await editor.commit(
      [renameTrack('t-midi', 'B')],
      {},
      { id: 'req-same', baseRevision: 'rev-1' },
    );
    expect(b.status).toBe('rejected');
    expect(errorCode(b)).toBe('id_conflict');
    expect(host.revision).toBe('rev-1');
    expect(host.state(editor.session).data.tracks[0]!.name).toBe('A');
  });

  it('different baseRevision with the same id is also id_conflict (it is part of the request body)', async () => {
    const { editor } = makeFixture();
    await editor.commit([renameTrack('t-midi', 'A')], {}, { id: 'req-x', baseRevision: 'rev-0' });
    const r = await editor.commit(
      [renameTrack('t-midi', 'A')],
      {},
      { id: 'req-x', baseRevision: 'rev-1' },
    );
    expect(errorCode(r)).toBe('id_conflict');
  });

  it('ids are scoped per session', async () => {
    const f = makeFixture();
    const other = f.grant({ role: 'edit' });
    const a = await f.editor.commit([renameTrack('t-midi', 'A')], {}, { id: 'shared-id' });
    const b = await other.commit([renameTrack('t-audio', 'B')], {}, { id: 'shared-id' });
    expect(a.status).toBe('succeeded');
    expect(b.status).toBe('succeeded');
    expect(f.host.revision).toBe('rev-2');
  });

  it('retry after success returns the original receipt, also via receipt.get', async () => {
    const { editor, host } = makeFixture();
    const first = await editor.commit(
      [renameTrack('t-midi', 'Receipt')],
      { label: 'rename' },
      { id: 'req-receipt' },
    );
    const receipt = output(first);
    expect(receipt.transactionId).toBe('req-receipt');
    expect(receipt.kind).toBe('commit');
    expect(receipt.baseRevision).toBe('rev-0');
    expect(receipt.revision).toBe('rev-1');
    expect(receipt.label).toBe('rename');
    expect(receipt.operations).toEqual(['track.update']);
    const got = output(await editor.call('receipt.get', { requestId: 'req-receipt' }));
    expect(got).toMatchObject({
      requestId: 'req-receipt',
      action: 'transaction.commit',
      status: 'succeeded',
    });
    expect(got.receipt).toEqual(receipt);
    expect(host.revision).toBe('rev-1');
  });

  it('a failed request is recorded and replays identically', async () => {
    const { editor, host } = makeFixture();
    const req = editor.request(
      'transaction.commit',
      { transaction: { operations: [renameTrack('nope', 'x')] } },
      {
        id: 'req-fail',
        baseRevision: 'rev-0',
      },
    );
    const first = await host.handle(req);
    expect(first.status).toBe('rejected');
    expect(JSON.stringify(await host.handle(structuredClone(req)))).toBe(JSON.stringify(first));
    const rec = output(await editor.call('receipt.get', { requestId: 'req-fail' }));
    expect(rec).toMatchObject({ status: 'rejected', errorCode: first.error?.code });
    expect(rec.receipt).toBeUndefined();
  });

  it('receipt.get on an unknown request is not_found; ledger retention evicts old records', async () => {
    const f = makeFixture({ ledgerRetention: 2 });
    expect(errorCode(await f.editor.call('receipt.get', { requestId: 'never' }))).toBe('not_found');
    await f.editor.call('project.inspect', {}, { id: 'r1' });
    await f.editor.call('project.inspect', {}, { id: 'r2' });
    await f.editor.call('project.inspect', {}, { id: 'r3' });
    expect(errorCode(await f.editor.call('receipt.get', { requestId: 'r1' }))).toBe('not_found');
    expect((await f.editor.call('receipt.get', { requestId: 'r3' })).status).toBe('succeeded');
  });
});

describe('internal errors', () => {
  it('an unexpected exception yields failed/internal_error with a generic message and no state change', async () => {
    const seen: unknown[] = [];
    const f = makeFixture({ onInternalError: (e: unknown) => seen.push(e) });
    // Simulate a host bug inside action execution.
    (f.host as unknown as { describeProject: () => never }).describeProject = () => {
      throw new Error('secret internal detail /Users/someone/project');
    };
    const before = JSON.stringify(f.host.state(f.reader.session));
    const r = await f.editor.call('project.describe');
    expect(r.status).toBe('failed');
    expect(errorCode(r)).toBe('internal_error');
    expect(JSON.stringify(r)).not.toContain('secret internal detail');
    expect(JSON.stringify(r)).not.toContain('/Users/');
    expect(JSON.stringify(f.host.state(f.reader.session))).toBe(before);
    expect(seen).toHaveLength(1);
  });
});

describe('DoD 3: atomicity', () => {
  it('a 3-op transaction whose 3rd op fails leaves state and revision unchanged; operationIndex 2 via receipt.get', async () => {
    const { editor, host } = makeFixture();
    const before = JSON.stringify(output(await editor.call('project.inspect')));
    const r = await editor.commit(
      [
        renameTrack('t-midi', 'Changed'),
        renameClip('c-midi', 'Changed clip'),
        noteUpdate('no-such-note', { pitch: 1 }),
      ],
      {},
      { id: 'req-atomic' },
    );
    expect(r.status).toBe('rejected');
    expect(r.revision).toBe('rev-0');
    expect(host.revision).toBe('rev-0');
    expect(JSON.stringify(output(await editor.call('project.inspect')))).toBe(before);

    const rec = output(await editor.call('receipt.get', { requestId: 'req-atomic' }));
    expect(rec.status).toBe('rejected');
    expect(rec.diagnostics.length).toBeGreaterThan(0);
    expect(rec.diagnostics[0].operationIndex).toBe(2);
    expect(rec.receipt).toBeUndefined();
    expect(output(await editor.call('history.list')).entries).toEqual([]);
  });

  it('an invariant failure after applying all ops is validation_failed and changes nothing', async () => {
    const { editor, host } = makeFixture();
    // removing a track that another track outputs to breaks routing
    const r = await editor.commit([{ op: 'track.remove', trackId: 't-bus' }]);
    expect(r.status).toBe('rejected');
    expect(['validation_failed', 'precondition_failed']).toContain(errorCode(r));
    expect(host.revision).toBe('rev-0');
    expect(host.state(editor.session).data.tracks).toHaveLength(3);
  });

  it('transaction.validate reports problems as a successful read and never changes state', async () => {
    const { editor, host } = makeFixture();
    const bad = output(
      await editor.call('transaction.validate', {
        transaction: {
          operations: [renameTrack('t-midi', 'x'), noteUpdate('ghost', { pitch: 3 })],
        },
      }),
    );
    expect(bad.valid).toBe(false);
    expect(bad.diagnostics[0].operationIndex).toBe(1);
    const good = output(
      await editor.call('transaction.validate', {
        transaction: { operations: [renameTrack('t-midi', 'x')] },
      }),
    );
    expect(good.valid).toBe(true);
    expect(good.baseRevision).toBe('rev-0');
    expect(good.changes.length).toBeGreaterThan(0);
    expect(host.revision).toBe('rev-0');
  });
});

describe('DoD 4: baseRevision', () => {
  it('a stale baseRevision is conflict', async () => {
    const { editor, host } = makeFixture();
    await editor.commit([renameTrack('t-midi', 'One')]);
    const r = await editor.commit([renameTrack('t-midi', 'Two')], {}, { baseRevision: 'rev-0' });
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('conflict');
    expect(r.error?.next).toBe('reread');
    expect(host.revision).toBe('rev-1');
  });

  it('a missing baseRevision on a write action is invalid_params', async () => {
    const { editor, host } = makeFixture();
    const r = await editor.commit([renameTrack('t-midi', 'x')], {}, { baseRevision: null });
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('invalid_params');
    expect(host.revision).toBe('rev-0');
  });

  it('proposal.create and undo/redo/accept follow the exemption table', async () => {
    const { editor } = makeFixture();
    // read actions never need it
    expect((await editor.call('project.inspect')).status).toBe('succeeded');
    // a write action that is not exempt needs it
    expect(errorCode(await editor.call('history.undo'))).toBe('invalid_params');
    expect(
      errorCode(await editor.call('proposal.reject', { proposalId: 'p' }, { baseRevision: null })),
    ).not.toBe('conflict');
  });

  it('a wrong-shaped request after authorization reports JSON-path diagnostics', async () => {
    const { editor } = makeFixture();
    const r = await editor.call('transaction.validate', {
      transaction: { operations: [{ op: 'track.update', trackId: 5 }] },
    });
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('invalid_params');
    const rec = output(await editor.call('receipt.get', { requestId: r.id }));
    expect(rec.diagnostics[0].path).toMatch(/^\/transaction\/operations\/0/);
  });
});

describe('DoD 10: limits', () => {
  it('maxOperationsPerTransaction is limit_exceeded for commit, validate-as-invalid and propose', async () => {
    const f = makeFixture({ limits: { maxOperationsPerTransaction: 2 } });
    const ops = [
      renameTrack('t-midi', 'a'),
      renameTrack('t-audio', 'b'),
      renameTrack('t-bus', 'c'),
    ];
    const r = await f.editor.commit(ops);
    expect(errorCode(r)).toBe('limit_exceeded');
    expect(f.host.revision).toBe('rev-0');
    expect(errorCode(await f.editor.propose(ops))).toBe('limit_exceeded');
    const v = output(
      await f.editor.call('transaction.validate', { transaction: { operations: ops } }),
    );
    expect(v.valid).toBe(false);
    expect((await f.editor.commit(ops.slice(0, 2))).status).toBe('succeeded');
  });

  it('maxRequestBytes is limit_exceeded and is not recorded in the ledger', async () => {
    const f = makeFixture({ limits: { maxRequestBytes: 1500 } });
    const huge = 'x'.repeat(4000);
    const r = await f.editor.commit([renameTrack('t-midi', huge)], {}, { id: 'req-big' });
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('limit_exceeded');
    expect(f.host.revision).toBe('rev-0');
    expect(errorCode(await f.editor.call('receipt.get', { requestId: 'req-big' }))).toBe(
      'not_found',
    );
    expect((await f.editor.commit([renameTrack('t-midi', 'small')])).status).toBe('succeeded');
  });

  it('maxNotesPerClip is enforced', async () => {
    const f = makeFixture({ limits: { maxNotesPerClip: 9 } });
    const add = (id: string) => ({
      op: 'midi.notes.add',
      clipId: 'c-midi',
      notes: [{ id, pitch: 60, start: 3.5, duration: 0.25, velocity: 90 }],
    });
    expect((await f.editor.commit([add('extra-1')])).status).toBe('succeeded'); // 9 notes
    expect(errorCode(await f.editor.commit([add('extra-2')]))).toBe('limit_exceeded');
  });
});

describe('initial project', () => {
  it('a host refuses an initial project with duplicate ids instead of dropping one', () => {
    const project = demoProject();
    const clip = project.tracks[0]!.clips[0]!;
    if (clip.type !== 'midi') throw new Error('fixture changed');
    clip.notes.push({ ...clip.notes[0]! });
    expect(() => makeFixture({ project })).toThrow(/duplicate note id/);
  });
});
