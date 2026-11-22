import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CORE_PROTOCOL } from '@wty.dev/aep-schema';
import type { CoreRequest } from '@wty.dev/aep-schema';
import { StdioClientTransport, serveStdio } from './stdio.js';
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

type Line = { type?: string; result?: { id: string; status: string; error?: { code: string } } };

const collectLines = (stream: PassThrough, lines: Line[]): void => {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      lines.push(JSON.parse(buf.slice(0, nl)) as Line);
      buf = buf.slice(nl + 1);
    }
  });
};

const until = (pred: () => boolean, timeoutMs = 5000): Promise<void> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (pred()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error('until() timed out'));
      else setTimeout(check, 5);
    };
    check();
  });

describe('stdio binding', () => {
  it('sends hello, matches pipelined results by id, answers meta lines', async () => {
    const clientToHost = new PassThrough();
    const hostToClient = new PassThrough();
    const serving = serveStdio({
      handler: new FakeHandler(),
      input: clientToHost,
      output: hostToClient,
    });
    const client = new StdioClientTransport(hostToClient, clientToHost);

    const manifest = await client.hello;
    expect(manifest.session).toBe('sess-test');

    const order: string[] = [];
    const p1 = client.send(makeReq('req-s1', { delayMs: 100 })).then((r) => {
      order.push(r.id);
      return r;
    });
    const p2 = client.send(makeReq('req-s2')).then((r) => {
      order.push(r.id);
      return r;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.id).toBe('req-s1');
    expect(r1.status).toBe('succeeded');
    expect(r2.id).toBe('req-s2');
    expect(order).toEqual(['req-s2', 'req-s1']);

    const state = await client.state();
    expect(state.revision).toBe('rev-1');
    const m = await client.manifest();
    expect(m.workspace).toBe('ws-test');

    await client.close();
    clientToHost.end();
    await serving;
  });

  it('replies bad_request with id "invalid" for a malformed line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const serving = serveStdio({ handler: new FakeHandler(), input, output });
    const lines: Line[] = [];
    collectLines(output, lines);

    input.write('this is not json\n');
    await until(() => lines.some((l) => l.type === 'result'));

    const hello = lines.find((l) => l.type === 'hello');
    expect(hello).toBeDefined();
    const res = lines.find((l) => l.type === 'result')?.result;
    expect(res?.id).toBe('invalid');
    expect(res?.status).toBe('rejected');
    expect(res?.error?.code).toBe('bad_request');

    input.end();
    await serving;
  });
});

describe('StdioClientTransport hardening', () => {
  const pair = () => {
    const fromHost = new PassThrough();
    const toHost = new PassThrough();
    return { fromHost, toHost, client: new StdioClientTransport(fromHost, toHost) };
  };

  it('refuses a second in-flight request with the same id', async () => {
    const { client } = pair();
    const first = client.send(makeReq('dup-1'));
    await expect(client.send(makeReq('dup-1'))).rejects.toThrow(/already in flight/);
    await client.close();
    await expect(first).rejects.toThrow();
  });

  it('fails the matching request on an invalid result document', async () => {
    const { fromHost, client } = pair();
    const p = client.send(makeReq('bad-1'));
    fromHost.write(
      JSON.stringify({ type: 'result', result: { id: 'bad-1', status: 'weird' } }) + '\n',
    );
    await expect(p).rejects.toThrow(/invalid result/);
    await client.close();
  });

  it('times out a request the host never answers', async () => {
    const { client } = pair();
    client.requestTimeoutMs = 20;
    await expect(client.send(makeReq('slow-1'))).rejects.toThrow(/timed out/);
    await client.close();
  });

  it('fails every pending request on a result that cannot be attributed', async () => {
    const { fromHost, client } = pair();
    const a = client.send(makeReq('pend-a'));
    const b = client.send(makeReq('pend-b'));
    fromHost.write('null\n');
    fromHost.write(JSON.stringify({ type: 'result', result: { status: 'weird' } }) + '\n');
    await expect(a).rejects.toThrow(/invalid result/);
    await expect(b).rejects.toThrow(/invalid result/);
    await client.close();
  });

  it('rejects hello, pending calls and later calls once the host stream ends', async () => {
    const { fromHost, client } = pair();
    const pending = client.send(makeReq('end-1'));
    const meta = client.state();
    fromHost.end();
    await expect(client.hello).rejects.toThrow(/ended/);
    await expect(pending).rejects.toThrow(/ended/);
    await expect(meta).rejects.toThrow(/ended/);
    await expect(client.send(makeReq('end-2'))).rejects.toThrow(/ended/);
    await expect(client.manifest()).rejects.toThrow(/ended/);
  });

  it('times out a state() call the host never answers', async () => {
    const { client } = pair();
    client.requestTimeoutMs = 20;
    await expect(client.state()).rejects.toThrow(/timed out/);
    await client.close();
  });

  it('a spawn of a missing command fails hello instead of crashing', async () => {
    const client = StdioClientTransport.spawn('/nonexistent/aep-host-binary');
    await expect(client.hello).rejects.toThrow();
    await expect(client.send(makeReq('x'))).rejects.toThrow();
  });
});

describe('stdio UTF-8 framing', () => {
  it('keeps a multi-byte character split across chunks intact on both sides', async () => {
    const clientToHost = new PassThrough();
    const hostToClient = new PassThrough();
    const serving = serveStdio({
      handler: new FakeHandler(),
      input: clientToHost,
      output: hostToClient,
    });
    // Re-chunk the host's output one byte at a time before the client sees it.
    const bytewise = new PassThrough();
    hostToClient.on('data', (chunk: Buffer) => {
      for (const byte of chunk) bytewise.write(Buffer.from([byte]));
    });
    const client = new StdioClientTransport(bytewise, new PassThrough());
    await client.hello;

    // Host side: write one request split inside the 4-byte '🎹'.
    const req = Buffer.from(JSON.stringify(makeReq('utf-1', { text: 'é🎹ü' })) + '\n', 'utf8');
    const cut = req.indexOf(Buffer.from('🎹', 'utf8')) + 2;
    const lines: Line[] = [];
    collectLines(hostToClient, lines);
    clientToHost.write(req.subarray(0, cut));
    clientToHost.write(req.subarray(cut));
    await until(() => lines.some((l) => l.type === 'result'));
    const res = lines.find((l) => l.type === 'result')?.result as unknown as {
      output: { echo: { text: string } };
    };
    expect(res.output.echo.text).toBe('é🎹ü');
    await until(() => true);
    await client.close();
    clientToHost.end();
    await serving;
  });
});
