import { describe, expect, it } from 'vitest';
import { errorCode, makeFixture, noteUpdate, output, renameTrack } from './test-harness.js';

const trackName = (f: ReturnType<typeof makeFixture>, id: string): string | undefined =>
  f.host.state(f.reader.session).data.tracks.find((t) => t.id === id)?.name;

describe('DoD 7: history', () => {
  it('undo restores the content and creates a new revision (never rewinds)', async () => {
    const f = makeFixture();
    const original = JSON.stringify(f.host.state(f.reader.session).data);
    await f.editor.commit([renameTrack('t-midi', 'Changed')]);
    const r = await f.editor.write('history.undo', {});
    const receipt = output(r);
    expect(receipt.kind).toBe('undo');
    expect(receipt.revision).toBe('rev-2');
    expect(receipt.baseRevision).toBe('rev-1');
    expect(receipt.targetTransactionId).toBeDefined();
    expect(receipt.operations).toEqual([]);
    expect(JSON.stringify(f.host.state(f.reader.session).data)).toBe(original);
    const list = output(await f.reader.call('history.list'));
    expect(list.entries.map((e: { kind: string }) => e.kind)).toEqual(['commit', 'undo']);
    expect(list.canUndo).toBe(false);
    expect(list.canRedo).toBe(true);
  });

  it('redo re-applies the undone change as another new revision', async () => {
    const f = makeFixture();
    await f.editor.commit([renameTrack('t-midi', 'Changed')]);
    await f.editor.write('history.undo', {});
    const r = output(await f.editor.write('history.redo', {}));
    expect(r.kind).toBe('redo');
    expect(r.revision).toBe('rev-3');
    expect(trackName(f, 't-midi')).toBe('Changed');
    const list = output(await f.reader.call('history.list'));
    expect(list.canRedo).toBe(false);
    expect(list.canUndo).toBe(true);
    // redo is itself undoable
    await f.editor.write('history.undo', {});
    expect(trackName(f, 't-midi')).toBe('Keys');
  });

  it('undo walks back through several commits in order', async () => {
    const f = makeFixture();
    await f.editor.commit([renameTrack('t-midi', 'One')]);
    await f.editor.commit([renameTrack('t-audio', 'Two')]);
    await f.editor.write('history.undo', {});
    expect(trackName(f, 't-audio')).toBe('Audio');
    expect(trackName(f, 't-midi')).toBe('One');
    await f.editor.write('history.undo', {});
    expect(trackName(f, 't-midi')).toBe('Keys');
    expect(errorCode(await f.editor.write('history.undo', {}))).toBe('nothing_to_undo');
    // redo twice restores both
    await f.editor.write('history.redo', {});
    await f.editor.write('history.redo', {});
    expect(trackName(f, 't-midi')).toBe('One');
    expect(trackName(f, 't-audio')).toBe('Two');
    expect(errorCode(await f.editor.write('history.redo', {}))).toBe('nothing_to_redo');
  });

  it('undoing an explicit older transaction works when nothing later touched the same entities', async () => {
    const f = makeFixture();
    const a = await f.editor.commit([renameTrack('t-midi', 'A')]);
    await f.editor.commit([renameTrack('t-audio', 'B')]);
    const r = await f.editor.write('history.undo', { transactionId: a.id });
    expect(r.status).toBe('succeeded');
    expect(trackName(f, 't-midi')).toBe('Keys');
    expect(trackName(f, 't-audio')).toBe('B');
  });

  it('undo_conflict when a later commit touched the same entity; nothing changes', async () => {
    const f = makeFixture();
    const a = await f.editor.commit([noteUpdate('n1', { velocity: 50 })]);
    await f.editor.commit([noteUpdate('n1', { velocity: 70 })]);
    const r = await f.editor.write('history.undo', { transactionId: a.id });
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('undo_conflict');
    expect(f.host.revision).toBe('rev-2');
    // the later commit can be undone, after which the earlier one can too
    expect((await f.editor.write('history.undo', {})).status).toBe('succeeded');
    expect((await f.editor.write('history.undo', { transactionId: a.id })).status).toBe(
      'succeeded',
    );
  });

  it('nothing_to_undo on a fresh project; nothing_to_redo when no undo happened', async () => {
    const f = makeFixture();
    expect(errorCode(await f.editor.write('history.undo', {}))).toBe('nothing_to_undo');
    expect(errorCode(await f.editor.write('history.redo', {}))).toBe('nothing_to_redo');
    const list = output(await f.reader.call('history.list'));
    expect(list).toMatchObject({ entries: [], canUndo: false, canRedo: false });
  });

  it('a new commit clears the redo stack', async () => {
    const f = makeFixture();
    await f.editor.commit([renameTrack('t-midi', 'One')]);
    await f.editor.write('history.undo', {});
    expect(output(await f.reader.call('history.list')).canRedo).toBe(true);
    await f.editor.commit([renameTrack('t-audio', 'Two')]);
    expect(output(await f.reader.call('history.list')).canRedo).toBe(false);
    expect(errorCode(await f.editor.write('history.redo', {}))).toBe('nothing_to_redo');
  });

  it('unknown, already-undone and undo-kind explicit targets are rejected', async () => {
    const f = makeFixture();
    const a = await f.editor.commit([renameTrack('t-midi', 'One')]);
    expect(errorCode(await f.editor.write('history.undo', { transactionId: 'nope' }))).toBe(
      'not_found',
    );
    const undo = await f.editor.write('history.undo', { transactionId: a.id });
    expect(errorCode(await f.editor.write('history.undo', { transactionId: a.id }))).toBe(
      'precondition_failed',
    );
    expect(errorCode(await f.editor.write('history.undo', { transactionId: undo.id }))).toBe(
      'precondition_failed',
    );
  });

  it('undoing an accepted proposal restores the pre-proposal state', async () => {
    const f = makeFixture();
    const p = output(await f.proposer.propose([renameTrack('t-midi', 'Prop')]));
    await f.editor.write('proposal.accept', { proposalId: p.id });
    expect(trackName(f, 't-midi')).toBe('Prop');
    expect((await f.editor.write('history.undo', {})).status).toBe('succeeded');
    expect(trackName(f, 't-midi')).toBe('Keys');
  });

  it('history.list returns the last N entries in chronological order', async () => {
    const f = makeFixture();
    for (const n of ['a', 'b', 'c']) await f.editor.commit([renameTrack('t-midi', n)]);
    const list = output(await f.reader.call('history.list', { limit: 2 }));
    expect(list.entries.map((e: { revision: string }) => e.revision)).toEqual(['rev-2', 'rev-3']);
  });

  it('undo receipts are retrievable via receipt.get with kind undo', async () => {
    const f = makeFixture();
    await f.editor.commit([renameTrack('t-midi', 'One')]);
    const undo = await f.editor.write('history.undo', {}, { id: 'req-undo' });
    expect(undo.status).toBe('succeeded');
    const rec = output(await f.editor.call('receipt.get', { requestId: 'req-undo' }));
    expect(rec.receipt.kind).toBe('undo');
  });

  it('undoing a clip insert after a note was added to it is undo_conflict, not a silent drop', async () => {
    const f = makeFixture();
    const dup = await f.editor.commit([
      { op: 'clip.duplicate', clipId: 'c-midi', newClipId: 'c-copy' },
    ]);
    expect(dup.status).toBe('succeeded');
    await f.editor.commit([
      {
        op: 'midi.notes.add',
        clipId: 'c-copy',
        notes: [{ id: 'n-new', pitch: 50, velocity: 80, start: 0, duration: 1 }],
      },
    ]);
    const r = await f.editor.write('history.undo', { transactionId: dup.id });
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('undo_conflict');
    expect(f.host.revision).toBe('rev-2');
  });

  it('undo by transactionId resolves to the caller session when ids collide across sessions', async () => {
    const f = makeFixture();
    const other = f.grant({ role: 'edit' });
    await f.editor.commit([renameTrack('t-midi', 'Mine')], {}, { id: 'shared-id' });
    await other.commit([renameTrack('t-audio', 'Theirs')], {}, { id: 'shared-id' });
    const r = await f.editor.write('history.undo', { transactionId: 'shared-id' });
    expect(r.status).toBe('succeeded');
    expect(trackName(f, 't-midi')).toBe('Keys');
    expect(trackName(f, 't-audio')).toBe('Theirs');
    // a third session cannot tell which one is meant
    const third = f.grant({ role: 'edit' });
    await f.editor.write('history.redo', {});
    expect(errorCode(await third.write('history.undo', { transactionId: 'shared-id' }))).toBe(
      'precondition_failed',
    );
  });
});
