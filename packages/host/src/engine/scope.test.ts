import { describe, expect, it } from 'vitest';
import { errorCode, makeFixture, noteUpdate, output, renameClip } from './test-harness.js';

describe('DoD 5: scope enforcement', () => {
  it('a session scoped to clip X cannot edit clip Y (scope_violation, nothing changes)', async () => {
    const f = makeFixture();
    const scoped = f.grant({ role: 'edit', scope: { clips: ['c-midi'] } });
    expect((await scoped.commit([renameClip('c-midi', 'Mine')])).status).toBe('succeeded');
    const r = await scoped.commit([renameClip('c-audio', 'Not mine')]);
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('scope_violation');
    expect(f.host.revision).toBe('rev-1');
    const rec = output(await scoped.call('receipt.get', { requestId: r.id }));
    expect(rec.diagnostics[0].code).toBe('scope_violation');
  });

  it('a track-scoped session cannot make project-level changes', async () => {
    const f = makeFixture();
    const scoped = f.grant({ role: 'edit', scope: { tracks: ['t-midi'] } });
    const r = await scoped.commit([{ op: 'tempo.update', tempo: [{ beat: 0, bpm: 90 }] }]);
    expect(errorCode(r)).toBe('scope_violation');
  });

  it('a timeRange scope rejects a clip.move that drags notes outside the range', async () => {
    const f = makeFixture();
    const scoped = f.grant({
      role: 'edit',
      scope: { timeRange: { start: 0, end: 4, unit: 'beats' } },
    });
    // moving the 4-beat clip to beat 2 puts its notes in 2..6 > 4
    const r = await scoped.commit([{ op: 'clip.move', clipId: 'c-midi', start: 2 }]);
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('scope_violation');
    expect(f.host.revision).toBe('rev-0');
    // an edit that stays inside the range is fine
    expect((await scoped.commit([noteUpdate('n1', { velocity: 90 })])).status).toBe('succeeded');
  });

  it('a transaction scope narrower than the session scope is enforced', async () => {
    const f = makeFixture();
    const scoped = f.grant({ role: 'edit', scope: { tracks: ['t-midi', 't-audio'] } });
    const ok = await scoped.commit([renameClip('c-audio', 'ok')], {
      scope: { clips: ['c-audio'] },
    });
    expect(ok.status).toBe('succeeded');
    const narrow = await scoped.commit([renameClip('c-midi', 'nope')], {
      scope: { clips: ['c-audio'] },
    });
    expect(errorCode(narrow)).toBe('scope_violation');
    expect(f.host.revision).toBe('rev-1');
  });

  it('a transaction scope cannot widen the session scope', async () => {
    const f = makeFixture();
    const scoped = f.grant({ role: 'edit', scope: { clips: ['c-midi'] } });
    const r = await scoped.commit([renameClip('c-audio', 'sneaky')], {
      scope: { clips: ['c-audio', 'c-midi'] },
    });
    expect(errorCode(r)).toBe('scope_violation');
  });

  it('an operations scope restricts which operations may be used', async () => {
    const f = makeFixture();
    const scoped = f.grant({ role: 'edit', scope: { operations: ['midi.notes.*'] } });
    expect((await scoped.commit([noteUpdate('n1', { velocity: 80 })])).status).toBe('succeeded');
    expect(errorCode(await scoped.commit([renameClip('c-midi', 'x')]))).toBe('scope_violation');
  });

  it('scope applies to proposals, validate and undo as well', async () => {
    const f = makeFixture();
    const scoped = f.grant({ role: 'edit', scope: { clips: ['c-midi'] } });
    expect(errorCode(await scoped.propose([renameClip('c-audio', 'x')]))).toBe('scope_violation');
    const v = output(
      await scoped.call('transaction.validate', {
        transaction: { operations: [renameClip('c-audio', 'x')] },
      }),
    );
    expect(v.valid).toBe(false);
    expect(v.diagnostics[0].code).toBe('scope_violation');

    // an unscoped editor changes c-audio; the scoped session may not undo it
    await f.editor.commit([renameClip('c-audio', 'by-editor')]);
    expect(errorCode(await scoped.write('history.undo', {}))).toBe('scope_violation');
    expect(f.host.revision).toBe('rev-1');
  });

  it('accepting a proposal is checked against the accepting session scope', async () => {
    const f = makeFixture();
    const p = output(await f.proposer.propose([renameClip('c-audio', 'proposed')]));
    const scoped = f.grant({ role: 'edit', scope: { clips: ['c-midi'] } });
    const r = await scoped.write('proposal.accept', { proposalId: p.id });
    expect(errorCode(r)).toBe('scope_violation');
    // the proposal stays open
    expect(output(await f.reader.call('proposal.get', { proposalId: p.id })).proposal.status).toBe(
      'open',
    );
    expect((await f.editor.write('proposal.accept', { proposalId: p.id })).status).toBe(
      'succeeded',
    );
  });

  it('a proposer’s own session scope still binds the proposal when someone else accepts it', async () => {
    const f = makeFixture();
    const scopedProposer = f.grant({ role: 'propose', scope: { clips: ['c-midi'] } });
    expect(errorCode(await scopedProposer.propose([renameClip('c-audio', 'x')]))).toBe(
      'scope_violation',
    );
  });

  it('read actions are not scope-filtered', async () => {
    const f = makeFixture();
    const scoped = f.grant({ role: 'edit', scope: { clips: ['c-midi'] } });
    const inspect = output(await scoped.call('project.inspect'));
    expect(inspect.project.tracks).toHaveLength(3);
  });

  it('a timeRange scope counts notes re-placed by a clip offset change', async () => {
    const f = makeFixture();
    const scoped = f.grant({
      role: 'edit',
      scope: { timeRange: { start: 0, end: 4, unit: 'beats' } },
    });
    // The clip stays at 0..4, but its notes now map to -2..2: outside the range.
    const r = await scoped.commit([{ op: 'clip.update', clipId: 'c-midi', patch: { offset: 2 } }]);
    expect(errorCode(r)).toBe('scope_violation');
    expect(f.host.revision).toBe('rev-0');
  });
});
