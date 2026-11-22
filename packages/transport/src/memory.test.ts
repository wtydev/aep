import { describe, expect, it } from 'vitest';
import { CORE_PROTOCOL } from '@wty.dev/aep-schema';
import type { CoreRequest } from '@wty.dev/aep-schema';
import { InMemoryTransport } from './memory.js';
import { FakeHandler } from './test-handler.js';

const makeReq = (id: string, params: Record<string, unknown> = {}): CoreRequest => ({
  protocol: CORE_PROTOCOL,
  session: 'sess-test',
  workspace: 'ws-test',
  id,
  credential: 'cred',
  action: 'test.echo',
  version: 1,
  params,
});

describe('InMemoryTransport', () => {
  it('roundtrips a request through the handler', async () => {
    const transport = new InMemoryTransport(new FakeHandler());
    const res = await transport.send(makeReq('req-m1', { hello: 'world' }));
    expect(res.status).toBe('succeeded');
    expect(res.id).toBe('req-m1');
    expect(res.revision).toBe('rev-1');
    expect(res.output).toEqual({ echo: { hello: 'world' } });
  });

  it('replays the identical result for a repeated request id', async () => {
    const transport = new InMemoryTransport(new FakeHandler());
    const a = await transport.send(makeReq('req-m2', { n: 1 }));
    const b = await transport.send(makeReq('req-m2', { n: 1 }));
    expect(b).toEqual(a);
  });

  it('returns manifest and state', async () => {
    const transport = new InMemoryTransport(new FakeHandler());
    expect((await transport.manifest()).session).toBe('sess-test');
    expect((await transport.state()).revision).toBe('rev-1');
  });
});
