import { describe, expect, it } from 'vitest';
import { errorCode, makeFixture, output, renameClip, renameTrack } from './test-harness.js';

const trackName = (f: ReturnType<typeof makeFixture>, id: string): string | undefined =>
  f.host.state(f.reader.session).data.tracks.find((t) => t.id === id)?.name;

describe('DoD 6: proposals', () => {
  it('creating a proposal changes neither project.inspect nor the revision', async () => {
    const f = makeFixture();
    const before = JSON.stringify(output(await f.reader.call('project.inspect')));
    const r = await f.proposer.propose([renameTrack('t-midi', 'Proposed')], { label: 'try this' });
    const p = output(r);
    expect(p.status).toBe('open');
    expect(p.baseRevision).toBe('rev-0');
    expect(p.label).toBe('try this');
    expect(p.client.session).toBe(f.proposer.session);
    expect(p.operations).toHaveLength(1);
    expect(p.changes.length).toBeGreaterThan(0);
    expect(r.revision).toBe('rev-0');
    expect(f.host.revision).toBe('rev-0');
    expect(JSON.stringify(output(await f.reader.call('project.inspect')))).toBe(before);
    expect(output(await f.reader.call('history.list')).entries).toEqual([]);
  });

  it('proposal.get with includeState shows the proposed state; without it omits state', async () => {
    const f = makeFixture();
    const p = output(await f.proposer.propose([renameTrack('t-midi', 'Proposed')]));
    const withState = output(
      await f.reader.call('proposal.get', { proposalId: p.id, includeState: true }),
    );
    expect(withState.state.tracks.find((t: { id: string }) => t.id === 't-midi').name).toBe(
      'Proposed',
    );
    const without = output(await f.reader.call('proposal.get', { proposalId: p.id }));
    expect(without.state).toBeUndefined();
    expect(trackName(f, 't-midi')).toBe('Keys');
    const listed = output(await f.reader.call('proposal.list', {}));
    expect(listed.proposals.map((x: { id: string }) => x.id)).toEqual([p.id]);
    expect(
      output(await f.reader.call('proposal.list', { status: ['accepted'] })).proposals,
    ).toEqual([]);
  });

  it('accept commits the proposal as a revision with a proposal receipt', async () => {
    const f = makeFixture();
    const p = output(await f.proposer.propose([renameTrack('t-midi', 'Accepted')], { label: 'L' }));
    const r = await f.editor.write('proposal.accept', { proposalId: p.id });
    const receipt = output(r);
    expect(receipt.kind).toBe('proposal');
    expect(receipt.proposalId).toBe(p.id);
    expect(receipt.revision).toBe('rev-1');
    expect(receipt.label).toBe('L');
    expect(trackName(f, 't-midi')).toBe('Accepted');
    const after = output(await f.reader.call('proposal.get', { proposalId: p.id }));
    expect(after.proposal.status).toBe('accepted');
    expect(after.proposal.acceptedRevision).toBe('rev-1');
    expect(after.state).toBeUndefined();
    expect(output(await f.reader.call('history.list')).entries[0].kind).toBe('proposal');
  });

  it('accept after an unrelated commit still succeeds and keeps both changes', async () => {
    const f = makeFixture();
    const p = output(await f.proposer.propose([renameTrack('t-midi', 'From proposal')]));
    expect((await f.editor.commit([renameTrack('t-audio', 'Unrelated')])).status).toBe('succeeded');
    const r = await f.editor.write('proposal.accept', { proposalId: p.id });
    expect(r.status).toBe('succeeded');
    expect(output(r).revision).toBe('rev-2');
    expect(trackName(f, 't-midi')).toBe('From proposal');
    expect(trackName(f, 't-audio')).toBe('Unrelated');
  });

  it('accept after a conflicting commit is proposal_stale and marks the proposal stale', async () => {
    const f = makeFixture();
    const p = output(await f.proposer.propose([renameTrack('t-midi', 'Mine')]));
    await f.editor.commit([renameTrack('t-midi', 'Theirs')]);
    const r = await f.editor.write('proposal.accept', { proposalId: p.id });
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('proposal_stale');
    expect(f.host.revision).toBe('rev-1');
    expect(trackName(f, 't-midi')).toBe('Theirs');
    expect(output(await f.reader.call('proposal.get', { proposalId: p.id })).proposal.status).toBe(
      'stale',
    );
    // stays stale
    expect(errorCode(await f.editor.write('proposal.accept', { proposalId: p.id }))).toBe(
      'proposal_stale',
    );
  });

  it('a stale proposal can still be rejected', async () => {
    const f = makeFixture();
    const p = output(await f.proposer.propose([renameTrack('t-midi', 'Mine')]));
    await f.editor.commit([renameTrack('t-midi', 'Theirs')]);
    await f.editor.write('proposal.accept', { proposalId: p.id });
    const r = await f.editor.write('proposal.reject', { proposalId: p.id });
    expect(output(r).status).toBe('rejected');
  });

  it('reject closes the proposal; accepting it afterwards is proposal_closed', async () => {
    const f = makeFixture();
    const p = output(await f.proposer.propose([renameTrack('t-midi', 'Nope')]));
    const rej = output(await f.editor.write('proposal.reject', { proposalId: p.id }));
    expect(rej.status).toBe('rejected');
    const acc = await f.editor.write('proposal.accept', { proposalId: p.id });
    expect(errorCode(acc)).toBe('proposal_closed');
    expect(errorCode(await f.editor.write('proposal.reject', { proposalId: p.id }))).toBe(
      'proposal_closed',
    );
    expect(f.host.revision).toBe('rev-0');
    // an accepted proposal is closed too
    const q = output(await f.proposer.propose([renameTrack('t-midi', 'Yes')]));
    await f.editor.write('proposal.accept', { proposalId: q.id });
    expect(errorCode(await f.editor.write('proposal.accept', { proposalId: q.id }))).toBe(
      'proposal_closed',
    );
  });

  it('unknown proposals are not_found', async () => {
    const f = makeFixture();
    expect(errorCode(await f.reader.call('proposal.get', { proposalId: 'nope' }))).toBe(
      'not_found',
    );
    expect(errorCode(await f.editor.write('proposal.accept', { proposalId: 'nope' }))).toBe(
      'not_found',
    );
  });

  it('the propose role can create but not accept or reject', async () => {
    const f = makeFixture();
    const p = output(await f.proposer.propose([renameTrack('t-midi', 'x')]));
    expect(errorCode(await f.proposer.write('proposal.accept', { proposalId: p.id }))).toBe(
      'not_authorized',
    );
    expect(errorCode(await f.proposer.write('proposal.reject', { proposalId: p.id }))).toBe(
      'not_authorized',
    );
    expect(f.host.revision).toBe('rev-0');
  });

  it('maxOpenProposals is limit_exceeded; closing one frees a slot', async () => {
    const f = makeFixture({ limits: { maxOpenProposals: 2 } });
    const a = output(await f.proposer.propose([renameTrack('t-midi', 'a')]));
    await f.proposer.propose([renameTrack('t-audio', 'b')]);
    const third = await f.proposer.propose([renameTrack('t-bus', 'c')]);
    expect(errorCode(third)).toBe('limit_exceeded');
    await f.editor.write('proposal.reject', { proposalId: a.id });
    expect((await f.proposer.propose([renameTrack('t-bus', 'c')])).status).toBe('succeeded');
  });

  it('a client-chosen proposalId is honoured once', async () => {
    const f = makeFixture();
    const r = await f.proposer.propose([renameTrack('t-midi', 'x')], { proposalId: 'prop-mine' });
    expect(output(r).id).toBe('prop-mine');
    expect(
      errorCode(
        await f.proposer.propose([renameTrack('t-audio', 'y')], { proposalId: 'prop-mine' }),
      ),
    ).toBe('precondition_failed');
  });

  it('proposal.create requires a valid transaction', async () => {
    const f = makeFixture();
    expect(errorCode(await f.proposer.propose([renameClip('ghost', 'x')]))).toBeDefined();
    expect(output(await f.reader.call('proposal.list', {})).proposals).toEqual([]);
  });

  it('accept is proposal_stale when the proposal adds a note to a clip removed meanwhile', async () => {
    const f = makeFixture();
    const p = output(
      await f.proposer.propose([
        {
          op: 'midi.notes.add',
          clipId: 'c-midi',
          notes: [{ id: 'n-new', pitch: 50, velocity: 80, start: 0, duration: 1 }],
        },
      ]),
    );
    await f.editor.commit([{ op: 'clip.remove', clipId: 'c-midi' }]);
    const r = await f.editor.write('proposal.accept', { proposalId: p.id });
    expect(errorCode(r)).toBe('proposal_stale');
    expect(f.host.revision).toBe('rev-1');
  });
});
