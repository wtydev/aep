import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AepError } from './errors.js';
import { resolveInsideRoot } from './paths.js';

let root: string;
let outside: string;

const expectRejected = async (relative: string): Promise<void> => {
  try {
    await resolveInsideRoot(root, relative);
    expect.unreachable(`expected path_rejected for ${JSON.stringify(relative)}`);
  } catch (e) {
    expect(e).toBeInstanceOf(AepError);
    expect((e as AepError).code).toBe('path_rejected');
  }
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aep-root-'));
  outside = await mkdtemp(join(tmpdir(), 'aep-outside-'));
  await mkdir(join(root, 'nested', 'deep'), { recursive: true });
  await writeFile(join(root, 'nested', 'deep', 'ok.txt'), 'x');
  await writeFile(join(outside, 'secret.txt'), 's');
  await symlink(outside, join(root, 'escape'), 'dir');
  await symlink(join(outside, 'secret.txt'), join(root, 'file-link'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('resolveInsideRoot', () => {
  it('resolves nested paths inside the root', async () => {
    const resolved = await resolveInsideRoot(root, 'nested/deep/ok.txt');
    expect(resolved).toBe(await realpath(join(root, 'nested', 'deep', 'ok.txt')));
  });

  it('resolves a non-existent leaf inside the root', async () => {
    const resolved = await resolveInsideRoot(root, 'nested/missing.txt');
    expect(resolved).toBe(join(await realpath(root), 'nested', 'missing.txt'));
  });

  it('rejects traversal, absolute paths, backslashes, drive letters, NUL and empty', async () => {
    await expectRejected('../x');
    await expectRejected('a/../../b');
    await expectRejected('a/../b');
    await expectRejected('..');
    await expectRejected('.');
    await expectRejected('/etc/passwd');
    await expectRejected('a\\b');
    await expectRejected('C:x');
    await expectRejected('C:\\x');
    await expectRejected('a\0b');
    await expectRejected('');
    await expectRejected('a//b');
    await expectRejected('a/./b');
    await expectRejected('nested/deep/');
  });

  it('rejects a symlinked directory pointing outside the root', async () => {
    await expectRejected('escape/secret.txt');
    await expectRejected('escape');
  });

  it('rejects a symlinked file pointing outside the root', async () => {
    await expectRejected('file-link');
  });
});
