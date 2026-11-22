import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCode, makeFixture, output } from './test-harness.js';
import { sniffWav } from './assets.js';

/** Minimal PCM WAV: `frames` frames of silence. */
function wavBytes(opts: { sampleRate: number; channels: number; frames: number }): Buffer {
  const blockAlign = opts.channels * 2;
  const dataSize = opts.frames * blockAlign;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(opts.channels, 22);
  b.writeUInt32LE(opts.sampleRate, 24);
  b.writeUInt32LE(opts.sampleRate * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataSize, 40);
  return b;
}

let base: string;
let inbox: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aep-assets-')));
  inbox = join(base, 'inbox');
  outside = join(base, 'outside');
  mkdirSync(join(inbox, 'sub'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(
    join(inbox, 'take.wav'),
    wavBytes({ sampleRate: 48_000, channels: 2, frames: 48_000 }),
  );
  writeFileSync(
    join(inbox, 'sub', 'deep.wav'),
    wavBytes({ sampleRate: 44_100, channels: 1, frames: 22_050 }),
  );
  writeFileSync(join(inbox, 'notes.txt'), 'not audio');
  writeFileSync(join(inbox, 'noext'), 'bytes');
  writeFileSync(
    join(outside, 'secret.wav'),
    wavBytes({ sampleRate: 48_000, channels: 1, frames: 10 }),
  );
  symlinkSync(join(outside, 'secret.wav'), join(inbox, 'link.wav'));
  symlinkSync(outside, join(inbox, 'linkdir'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const fixture = (extra = {}) => makeFixture({ importRoots: { inbox }, ...extra });

describe('DoD 8: assets', () => {
  it('imports a file from the inbox root into the store with a sniffed WAV header', async () => {
    const f = fixture();
    const r = await f.admin.call('asset.import', { path: 'take.wav' });
    const { asset } = output(r);
    expect(asset.mediaType).toBe('audio/wav');
    expect(asset.name).toBe('take.wav');
    expect(asset.sampleRate).toBe(48_000);
    expect(asset.channels).toBe(2);
    expect(asset.durationSeconds).toBe(1);
    expect(asset.byteLength).toBe(44 + 48_000 * 4);
    expect(asset.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(asset.portability).toBe('host-local');
    expect(asset.availability).toBe('available');
    // no host path anywhere in the result
    expect(JSON.stringify(r)).not.toContain(base);
    // importing does not bump the revision
    expect(f.host.revision).toBe('rev-0');
  });

  it('imports from a subdirectory and honours explicit assetId and mediaType', async () => {
    const f = fixture();
    const r = output(
      await f.admin.call('asset.import', { path: 'sub/deep.wav', assetId: 'a-deep' }),
    );
    expect(r.asset.id).toBe('a-deep');
    expect(r.asset.sampleRate).toBe(44_100);
    const dup = await f.admin.call('asset.import', { path: 'take.wav', assetId: 'a-deep' });
    expect(errorCode(dup)).toBe('precondition_failed');
    const typed = output(
      await f.admin.call('asset.import', { path: 'noext', mediaType: 'audio/flac' }),
    );
    expect(typed.asset.mediaType).toBe('audio/flac');
  });

  it('rejects ../ traversal, absolute paths and symlink escapes with path_rejected', async () => {
    const f = fixture();
    for (const path of [
      '../outside/secret.wav',
      'sub/../../outside/secret.wav',
      join(outside, 'secret.wav'),
      '/etc/passwd',
      'link.wav',
      'linkdir/secret.wav',
    ]) {
      const r = await f.admin.call('asset.import', { path });
      expect(r.status, path).toBe('rejected');
      expect(errorCode(r), path).toBe('path_rejected');
      // the host's own directories never leak (an absolute path the client sent may be echoed back)
      if (!path.startsWith('/')) expect(JSON.stringify(r), path).not.toContain(base);
      expect(JSON.stringify(r), path).not.toContain(inbox);
    }
    expect(output(await f.admin.call('asset.list', { store: true })).assets).toEqual([]);
  });

  it('rejects an unknown root with path_rejected', async () => {
    const f = fixture();
    const r = await f.admin.call('asset.import', { path: 'take.wav', root: 'elsewhere' });
    expect(errorCode(r)).toBe('path_rejected');
  });

  it('missing files, directories and unsupported types are rejected cleanly', async () => {
    const f = fixture();
    expect(errorCode(await f.admin.call('asset.import', { path: 'absent.wav' }))).toBe(
      'asset_not_found',
    );
    expect(errorCode(await f.admin.call('asset.import', { path: 'sub' }))).toBe('invalid_params'); // no extension
    expect(errorCode(await f.admin.call('asset.import', { path: 'notes.txt' }))).toBe(
      'invalid_params',
    );
    expect(errorCode(await f.admin.call('asset.import', { path: 'noext' }))).toBe('invalid_params');
    expect(
      errorCode(await f.admin.call('asset.import', { path: 'sub', mediaType: 'audio/wav' })),
    ).toBe('path_rejected');
  });

  it('enforces the import size limit', async () => {
    const f = fixture({ maxAssetBytes: 1000 });
    expect(errorCode(await f.admin.call('asset.import', { path: 'take.wav' }))).toBe(
      'limit_exceeded',
    );
  });

  it('an imported asset is not in the project until an asset.link commit', async () => {
    const f = fixture();
    const { asset } = output(await f.admin.call('asset.import', { path: 'take.wav' }));
    expect(
      output(await f.reader.call('asset.list', {})).assets.map((a: { id: string }) => a.id),
    ).toEqual(['a-1']);
    // inserting a clip that references the un-linked asset fails
    const clip = {
      op: 'clip.insert',
      trackId: 't-audio',
      clip: {
        id: 'c-new',
        type: 'audio',
        name: 'New',
        start: 8,
        duration: 4,
        timebase: 'beats',
        assetId: asset.id,
        sourceOffset: 0,
        playbackRate: 1,
      },
    };
    expect((await f.editor.commit([clip])).status).toBe('rejected');
    expect(f.host.revision).toBe('rev-0');

    const linked = await f.editor.commit([{ op: 'asset.link', assetId: asset.id }]);
    expect(linked.status).toBe('succeeded');
    expect(output(linked).created.length).toBeGreaterThan(0);
    expect(
      output(await f.reader.call('asset.list', {}))
        .assets.map((a: { id: string }) => a.id)
        .sort(),
    ).toEqual(['a-1', asset.id].sort());
    // now the clip can use it, and linking is undoable
    expect((await f.editor.commit([clip])).status).toBe('succeeded');
  });

  it('asset.list distinguishes the store from the project', async () => {
    const f = fixture();
    const { asset } = output(await f.admin.call('asset.import', { path: 'take.wav' }));
    const store = output(await f.reader.call('asset.list', { store: true })).assets;
    const project = output(await f.reader.call('asset.list', { store: false })).assets;
    expect(store.map((a: { id: string }) => a.id)).toEqual([asset.id]);
    expect(project.map((a: { id: string }) => a.id)).toEqual(['a-1']);
  });

  it('asset.link of an unknown asset fails and asset.unlink removes it from the project only', async () => {
    const f = fixture();
    expect(
      errorCode(await f.editor.commit([{ op: 'asset.link', assetId: 'ghost' }])),
    ).toBeDefined();
    expect(f.host.revision).toBe('rev-0');
    const { asset } = output(await f.admin.call('asset.import', { path: 'take.wav' }));
    await f.editor.commit([{ op: 'asset.link', assetId: asset.id }]);
    expect((await f.editor.commit([{ op: 'asset.unlink', assetId: asset.id }])).status).toBe(
      'succeeded',
    );
    expect(
      output(await f.reader.call('asset.list', { store: true })).assets.map(
        (a: { id: string }) => a.id,
      ),
    ).toEqual([asset.id]);
  });

  it('sniffWav ignores non-PCM and malformed data', () => {
    expect(sniffWav(new Uint8Array(4))).toBeUndefined();
    expect(sniffWav(Buffer.from('RIFFxxxxWAVEjunkjunkjunkjunk'))).toBeUndefined();
    const float = wavBytes({ sampleRate: 48_000, channels: 1, frames: 4 });
    float.writeUInt16LE(3, 20);
    expect(sniffWav(float)).toBeUndefined();
  });
});
