import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ACTION_NAMES, ROLE_ACTIONS } from '@aep/schema';
import { demoProject } from '../domain/fixtures.js';
import { AepHost } from './host.js';
import { errorCode, makeFixture, output, renameTrack } from './test-harness.js';

describe('DoD 1: authentication and authorization', () => {
  it('rejects a wrong credential with not_authorized', async () => {
    const { editor } = makeFixture();
    const r = await editor.call('project.inspect', {}, { credential: 'not-the-credential' });
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('not_authorized');
  });

  it('rejects an unknown session with not_authorized (indistinguishable from a wrong credential)', async () => {
    const { editor } = makeFixture();
    const unknown = await editor.call('project.inspect', {}, { session: 'sess-doesnotexist' });
    const wrong = await editor.call('project.inspect', {}, { credential: 'nope' });
    expect(errorCode(unknown)).toBe('not_authorized');
    expect(unknown.error?.message).toBe(wrong.error?.message);
  });

  it('rejects an expired session with session_expired (driven by the injected clock)', async () => {
    const f = makeFixture();
    const short = f.grant({ role: 'read', expiresAt: f.clock.now + 1000 });
    expect((await short.call('project.inspect')).status).toBe('succeeded');
    f.clock.advance(1000);
    const r = await short.call('project.inspect');
    expect(r.status).toBe('rejected');
    expect(errorCode(r)).toBe('session_expired');
  });

  it('applies the default session TTL', async () => {
    const f = makeFixture({ sessionTtlMs: 5000 });
    const s = f.grant({ role: 'read' });
    f.clock.advance(4999);
    expect((await s.call('project.inspect')).status).toBe('succeeded');
    f.clock.advance(1);
    expect(errorCode(await s.call('project.inspect'))).toBe('session_expired');
  });

  it('rejects a revoked session with session_revoked', async () => {
    const f = makeFixture();
    expect((await f.editor.call('project.inspect')).status).toBe('succeeded');
    f.host.revokeSession(f.editor.session);
    const r = await f.editor.call('project.inspect');
    expect(errorCode(r)).toBe('session_revoked');
    // other sessions are unaffected
    expect((await f.reader.call('project.inspect')).status).toBe('succeeded');
  });

  it('a revoked session with a wrong credential is still just not_authorized', async () => {
    const f = makeFixture();
    f.host.revokeSession(f.editor.session);
    expect(errorCode(await f.editor.call('project.inspect', {}, { credential: 'bad' }))).toBe(
      'not_authorized',
    );
  });

  it('rejects a workspace mismatch with not_authorized', async () => {
    const { editor } = makeFixture();
    const r = await editor.call('project.inspect', {}, { workspace: 'some-other-project' });
    expect(errorCode(r)).toBe('not_authorized');
  });

  it('a propose-role session can propose but cannot commit, accept, undo or import', async () => {
    const { proposer } = makeFixture({ importRoots: { inbox: tmpdir() } });
    for (const action of [
      'transaction.commit',
      'proposal.accept',
      'proposal.reject',
      'history.undo',
      'history.redo',
    ]) {
      const r = await proposer.write(action, {
        transaction: { operations: [renameTrack('t-midi', 'x')] },
        proposalId: 'p',
      });
      expect(errorCode(r), action).toBe('not_authorized');
    }
    const imp = await proposer.call('asset.import', { path: 'a.wav' });
    expect(errorCode(imp)).toBe('not_authorized');
    const ok = await proposer.propose([renameTrack('t-midi', 'Proposed')]);
    expect(ok.status).toBe('succeeded');
  });

  it('a read-role session cannot write or propose, but can read', async () => {
    const { reader } = makeFixture();
    expect(errorCode(await reader.commit([renameTrack('t-midi', 'x')]))).toBe('not_authorized');
    expect(errorCode(await reader.propose([renameTrack('t-midi', 'x')]))).toBe('not_authorized');
    expect((await reader.call('project.describe')).status).toBe('succeeded');
  });

  it('an edit-role session cannot import assets; admin can reach asset.import authorization', async () => {
    const f = makeFixture({ importRoots: { inbox: tmpdir() } });
    expect(errorCode(await f.editor.call('asset.import', { path: 'aep-no-such-file.wav' }))).toBe(
      'not_authorized',
    );
    // admin passes authorization and reaches the import itself
    expect(errorCode(await f.admin.call('asset.import', { path: 'aep-no-such-file.wav' }))).toBe(
      'asset_not_found',
    );
    // without import roots the capability is not declared at all
    const bare = makeFixture();
    expect(errorCode(await bare.admin.call('asset.import', { path: 'a.wav' }))).toBe(
      'capability_unsupported',
    );
  });

  it('allowedActions restricts a session below its role', async () => {
    const f = makeFixture();
    const narrow = f.grant({
      role: 'edit',
      allowedActions: ['project.inspect', 'transaction.validate'],
    });
    expect((await narrow.call('project.inspect')).status).toBe('succeeded');
    expect(errorCode(await narrow.commit([renameTrack('t-midi', 'x')]))).toBe('not_authorized');
    expect(errorCode(await narrow.call('history.list'))).toBe('not_authorized');
  });

  it('allowedActions cannot widen a role', async () => {
    const f = makeFixture();
    const s = f.grant({ role: 'read', allowedActions: ['transaction.commit', 'project.inspect'] });
    expect(errorCode(await s.commit([renameTrack('t-midi', 'x')]))).toBe('not_authorized');
    expect((await s.call('project.inspect')).status).toBe('succeeded');
  });

  it('rejects unknown actions in allowedActions at session creation', () => {
    const f = makeFixture();
    expect(() =>
      f.host.createSession({ client: 'c', role: 'read', allowedActions: ['nope.nope'] }),
    ).toThrow();
  });

  it('the manifest lists only the actions the session may use', () => {
    const f = makeFixture();
    const narrow = f.grant({
      role: 'edit',
      allowedActions: ['project.inspect', 'transaction.commit'],
    });
    const m = f.host.manifest(narrow.session);
    expect(m.actions.map((a) => a.id).sort()).toEqual(['project.inspect', 'transaction.commit']);
    expect(m.session).toBe(narrow.session);
    expect(m.workspace).toBe('demo');

    const reader = f.host.manifest(f.reader.session);
    expect(reader.actions.map((a) => a.id).sort()).toEqual([...ROLE_ACTIONS.read].sort());
    expect(reader.actions.every((a) => a.version === 1)).toBe(true);
    expect(reader.actions.every((a) => a.paramsSchema.startsWith('schemas/'))).toBe(true);

    const admin = f.host.manifest(f.admin.session);
    // admin may import, but this host has no import roots -> capability absent -> not listed
    expect(admin.actions.map((a) => a.id)).not.toContain('asset.import');
    expect(admin.actions.map((a) => a.id)).toContain('history.undo');
    for (const a of admin.actions) expect(ACTION_NAMES).toContain(a.id);
  });

  it('forSession returns a handler bound to one session', async () => {
    const f = makeFixture();
    const bound = f.host.forSession(f.reader.session);
    expect(bound.manifest().session).toBe(f.reader.session);
    expect(bound.state().session).toBe(f.reader.session);
    expect(bound.state().revision).toBe('rev-0');
    const r = await bound.handle(f.reader.request('project.inspect'));
    expect(r.status).toBe('succeeded');
    expect(() => f.host.forSession('sess-unknown')).toThrow();
  });

  it('manifest()/state() without a sessionId need exactly one session', () => {
    const f = makeFixture();
    expect(() => f.host.manifest()).toThrow(); // four sessions
    const solo = new AepHost({ project: demoProject(), clock: f.clock.read });
    expect(() => solo.manifest()).toThrow(); // none
    const g = solo.createSession({ client: 'only', role: 'read' });
    expect(solo.manifest().session).toBe(g.session);
    expect(solo.state().session).toBe(g.session);
  });

  it('never exposes the credential in results, receipts, manifest or state', async () => {
    const f = makeFixture();
    const creds = [
      f.editor.credential,
      f.admin.credential,
      f.reader.credential,
      f.proposer.credential,
    ];
    const results = [
      await f.editor.commit([renameTrack('t-midi', 'Renamed')]),
      await f.editor.call('project.inspect'),
      await f.editor.call('history.list'),
      await f.editor.call('aep.capabilities'),
      await f.editor.call('receipt.get', { requestId: 'req-missing' }),
      await f.editor.call('project.inspect', {}, { credential: 'wrong-credential-value' }),
      await f.reader.commit([renameTrack('t-midi', 'x')]),
    ];
    const committed = results[0]!;
    const receipt = await f.editor.call('receipt.get', { requestId: committed.id });
    const blob = JSON.stringify([
      results,
      receipt,
      f.host.manifest(f.editor.session),
      f.host.state(f.editor.session),
    ]);
    for (const c of creds) expect(blob).not.toContain(c);
    expect(blob).not.toContain('wrong-credential-value');
    expect(output(receipt).receipt.client).toEqual({
      name: 'client-edit',
      session: f.editor.session,
    });
  });

  it('malformed requests get bad_request without echoing unsafe ids', async () => {
    const f = makeFixture();
    const r = await f.host.handle({ session: '<script>', id: 'x'.repeat(500), junk: true });
    expect(r.status).toBe('rejected');
    expect(r.error?.code).toBe('bad_request');
    expect(r.session).toBe('invalid');
    expect(r.id).toBe('invalid');
    const nonObject = await f.host.handle('hello');
    expect(nonObject.error?.code).toBe('bad_request');
  });

  it('aep.capabilities negotiates the protocol version with the client list', async () => {
    const f = makeFixture();
    const ok = await f.editor.call('aep.capabilities', { versions: ['0.2', '0.1'] });
    expect(ok.status).toBe('succeeded');
    expect((ok.output as { aep: { protocolVersion: string } }).aep.protocolVersion).toBe('0.1');
    // Before 1.0 minor versions are incompatible.
    expect(errorCode(await f.editor.call('aep.capabilities', { versions: ['0.2'] }))).toBe(
      'unsupported_version',
    );
  });

  it('unknown action, unsupported version and missing capability are distinct errors', async () => {
    const f = makeFixture({ capabilities: ['aep.core', 'aep.history', 'aep.proposals'] });
    const s = f.grant({ role: 'admin' });
    expect(errorCode(await s.call('project.explode'))).toBe('unknown_action');
    expect(errorCode(await s.call('project.inspect', {}, { version: 2 }))).toBe(
      'unsupported_version',
    );
    expect(
      errorCode(await s.call('render.request', { target: 'mix', format: { container: 'wav' } })),
    ).toBe('capability_unsupported');
  });

  it('auth failures are not recorded in the ledger (receipt.get cannot find them)', async () => {
    const f = makeFixture();
    const id = 'req-auth-fail';
    await f.editor.call('project.inspect', {}, { id, credential: 'bad' });
    const r = await f.editor.call('receipt.get', { requestId: id });
    expect(errorCode(r)).toBe('not_found');
  });
});
