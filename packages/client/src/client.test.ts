import { describe, expect, it } from 'vitest';
import type { ActionName } from '@aep/schema';
import { InMemoryTransport } from '@aep/transport';
import type { ClientTransport } from '@aep/transport';
import { FakeHandler } from '../../transport/src/test-handler.js';
import { AepClient, AepRequestError } from './client.js';

const connect = (transport?: ClientTransport) =>
  AepClient.connect({
    transport: transport ?? new InMemoryTransport(new FakeHandler()),
    credential: 'cred',
  });

describe('AepClient', () => {
  it('connect() picks session/workspace from the manifest', async () => {
    const client = await connect();
    expect(client.session).toBe('sess-test');
    expect(client.workspace).toBe('ws-test');
    expect(client.manifest?.session).toBe('sess-test');
  });

  it('call() returns the output of a succeeded result', async () => {
    const client = await connect();
    const out = await client.call('project.inspect', {});
    expect(out).toEqual({ echo: {} });
  });

  it('call() throws AepRequestError on a rejected result', async () => {
    const client = await connect();
    const err = await client.call('test.boom' as ActionName, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AepRequestError);
    const aepErr = err as AepRequestError;
    expect(aepErr.code).toBe('bad_request');
    expect(aepErr.next).toBe('fix');
    expect(aepErr.result.status).toBe('rejected');
  });

  it('resends the identical request (same id) after a transport error', async () => {
    const inner = new InMemoryTransport(new FakeHandler());
    const seen: string[] = [];
    let fail = true;
    const flaky: ClientTransport = {
      send: async (req) => {
        seen.push(req.id);
        if (fail) {
          fail = false;
          throw new Error('transport boom');
        }
        return inner.send(req);
      },
      manifest: () => inner.manifest(),
      state: () => inner.state(),
      close: () => inner.close(),
    };
    const client = await connect(flaky);
    const out = await client.call('project.inspect', {});
    expect(out).toEqual({ echo: {} });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('tracks lastRevision from every result and uses it as baseRevision', async () => {
    const inner = new InMemoryTransport(new FakeHandler());
    const sent: { action: string; baseRevision?: string }[] = [];
    const spy: ClientTransport = {
      send: (req) => {
        sent.push({
          action: req.action,
          ...(req.baseRevision !== undefined ? { baseRevision: req.baseRevision } : {}),
        });
        return inner.send(req);
      },
      manifest: () => inner.manifest(),
      state: () => inner.state(),
      close: () => inner.close(),
    };
    const client = await connect(spy);
    expect(client.lastRevision).toBeUndefined();
    await client.call('project.inspect', {});
    expect(client.lastRevision).toBe('rev-1');
    // a write action picks up lastRevision as baseRevision
    await client.request('transaction.commit', {
      transaction: { operations: [{ op: 'project.update', patch: { name: 'x' } }] },
    });
    expect(sent[1]).toEqual({ action: 'transaction.commit', baseRevision: 'rev-1' });
    // reads do not send baseRevision by default
    await client.request('project.inspect', {});
    expect(sent[2]).toEqual({ action: 'project.inspect' });
  });

  it('returns the stored result verbatim for a repeated request id', async () => {
    const client = await connect();
    const a = await client.request('project.inspect', {}, { id: 'req-fixed1' });
    const b = await client.request('project.inspect', {}, { id: 'req-fixed1' });
    expect(b).toEqual(a);
  });

  it('a replayed old result does not move lastRevision backwards', async () => {
    const results: Record<string, string> = { old: 'rev-1', fresh: 'rev-5' };
    const transport: ClientTransport = {
      send: async (req) => ({
        protocol: req.protocol,
        session: req.session,
        workspace: req.workspace,
        id: req.id,
        status: 'succeeded',
        revision: results[req.id] ?? 'rev-9',
        output: {},
      }),
      manifest: () => new InMemoryTransport(new FakeHandler()).manifest(),
      state: () => new InMemoryTransport(new FakeHandler()).state(),
      close: async () => {},
    };
    const client = await connect(transport);
    const commit = {
      transaction: { operations: [{ op: 'project.update' as const, patch: { name: 'x' } }] },
    };
    await client.request('transaction.commit', commit, { id: 'old', baseRevision: 'rev-0' });
    expect(client.lastRevision).toBe('rev-1');
    await client.request('transaction.commit', commit, { id: 'fresh' });
    expect(client.lastRevision).toBe('rev-5');
    // retrying the first request verbatim (its old baseRevision) replays its old result
    await client.request('transaction.commit', commit, { id: 'old', baseRevision: 'rev-0' });
    expect(client.lastRevision).toBe('rev-5');
  });
});
