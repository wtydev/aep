import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_PROTOCOL, CoreState } from '@wty.dev/aep-schema';
import type { CoreRequest } from '@wty.dev/aep-schema';
import { DirectoryClientTransport, DirectoryHostBinding } from './directory.js';
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

const waitForFile = async (path: string, timeoutMs = 5000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
};

const tmpDir = () => mkdtemp(join(tmpdir(), 'aep-dir-'));

describe('directory binding', () => {
  it('serves a request/response roundtrip and consumes the request file', async () => {
    const dir = await tmpDir();
    const host = new DirectoryHostBinding({ dir, handler: new FakeHandler(), pollMs: 10 });
    await host.start();
    try {
      const client = new DirectoryClientTransport({ dir, pollMs: 10, timeoutMs: 5000 });
      const res = await client.send(makeReq('req-d1', { a: 1 }));
      expect(res.status).toBe('succeeded');
      expect(res.id).toBe('req-d1');
      expect(res.output).toEqual({ echo: { a: 1 } });
      // request file deleted after processing; result file written mode 0600
      await expect(stat(join(dir, 'requests', 'req-d1.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await stat(join(dir, 'results', 'req-d1.json'))).mode & 0o777).toBe(0o600);
    } finally {
      await host.stop();
    }
  });

  it('refuses to overwrite an existing request file', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, 'requests'), { recursive: true });
    await writeFile(join(dir, 'requests', 'req-dup.json'), '{}');
    const client = new DirectoryClientTransport({ dir, pollMs: 10, timeoutMs: 200 });
    await expect(client.send(makeReq('req-dup'))).rejects.toThrow(/EEXIST/);
    // the existing file is untouched
    expect(await readFile(join(dir, 'requests', 'req-dup.json'), 'utf8')).toBe('{}');
  });

  it('rejects unsafe request ids', async () => {
    const dir = await tmpDir();
    const client = new DirectoryClientTransport({ dir });
    await expect(client.send(makeReq('../escape'))).rejects.toThrow(/not safe/);
    await expect(client.send(makeReq('a/b'))).rejects.toThrow(/not safe/);
  });

  it('writes a bad_request result for a malformed request file', async () => {
    const dir = await tmpDir();
    const host = new DirectoryHostBinding({ dir, handler: new FakeHandler(), pollMs: 10 });
    await host.start();
    try {
      await writeFile(join(dir, 'requests', 'bad1.json'), 'this is not json');
      const res = JSON.parse(await waitForFile(join(dir, 'results', 'bad1.json'))) as {
        id: string;
        status: string;
        error: { code: string };
      };
      expect(res.id).toBe('bad1');
      expect(res.status).toBe('rejected');
      expect(res.error.code).toBe('bad_request');
      // malformed request file is consumed too
      await expect(stat(join(dir, 'requests', 'bad1.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await host.stop();
    }
  });

  it('publishes aep.json and state.json (mode 0600) and serves them to the client', async () => {
    const dir = await tmpDir();
    const host = new DirectoryHostBinding({ dir, handler: new FakeHandler(), pollMs: 10 });
    await host.start();
    try {
      expect((await stat(join(dir, 'aep.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, 'state.json'))).mode & 0o777).toBe(0o600);
      const client = new DirectoryClientTransport({ dir });
      const manifest = await client.manifest();
      expect(manifest.session).toBe('sess-test');
      const state = await client.state();
      expect(state.revision).toBe('rev-1');
      // state.json on disk is a valid CoreState document
      const onDisk = CoreState.parse(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')));
      expect(onDisk.workspace).toBe('ws-test');
    } finally {
      await host.stop();
    }
  });

  it('concurrent sends of one id: one publishes intact, the other fails, no temp files remain', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, 'requests'), { recursive: true });
    const client = new DirectoryClientTransport({ dir, pollMs: 10, timeoutMs: 100 });
    const results = await Promise.allSettled([
      client.send(makeReq('req-race', { n: 1 })),
      client.send(makeReq('req-race', { n: 2 })),
    ]);
    // nobody serves the request, so the winner times out; the loser fails on EEXIST
    expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')).join()).toMatch(
      /EEXIST/,
    );
    const body = JSON.parse(await readFile(join(dir, 'requests', 'req-race.json'), 'utf8'));
    expect([1, 2]).toContain(body.params.n);
    expect((await readdir(join(dir, 'requests'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
