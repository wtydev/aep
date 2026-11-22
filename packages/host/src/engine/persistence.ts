/**
 * On-disk state of a durable reference host.
 *
 * Layout under `dataDir` (created with mode 0700):
 *   host-state.json        one JSON document (mode 0600), replaced atomically
 *   assets/<sha256 hex>    asset bytes, content-addressed (mode 0600)
 *
 * The state file holds credential HASHES only, never credentials, and no absolute host paths.
 * `open` refuses a layout it does not control: a symlinked, foreign-owned, or group/other-writable
 * data or assets directory, or a state file that is not a regular file owned by this process.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { sha256Hex } from '@wty.dev/aep-core';

export const STATE_FILE = 'host-state.json';
export const ASSETS_DIR = 'assets';
export const STATE_FORMAT_VERSION = 1;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A failed persistence write. `committed` is true when the new state file may already be in place. */
export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly committed: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PersistenceError';
  }
}

/** Read a file without following a symlink at the final component. */
async function readNoFollow(path: string): Promise<Buffer> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** Reject `path` unless it is a `kind` (not a symlink) owned by this process and not group/other-writable. */
async function checkOwned(path: string, kind: 'directory' | 'file'): Promise<void> {
  const st = await lstat(path);
  const isKind = kind === 'directory' ? st.isDirectory() : st.isFile();
  if (!isKind) throw new Error(`${path} must be a ${kind}, not a symlink or other file type`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${path} is not owned by this user`);
  if ((st.mode & 0o022) !== 0) throw new Error(`${path} is writable by group or others`);
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Write `bytes` to a new `.<stem>.<random>.tmp` file (0600) in `dir`, fsync it, rename it to `name`. */
async function writeFileAtomic(
  dir: string,
  name: string,
  stem: string,
  bytes: Uint8Array,
): Promise<void> {
  const tmp = join(dir, `.${stem}.${randomBytes(8).toString('hex')}.tmp`);
  const final = join(dir, name);
  let fh: FileHandle | undefined;
  try {
    fh = await open(tmp, 'wx', FILE_MODE);
    await fh.writeFile(bytes);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmp, final);
  } catch (e) {
    await fh?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** Reads and writes the files of one data directory. All writes must be serialized by the caller. */
export class StateFiles {
  /** Blobs verified (hash checked) and durable. */
  private readonly known = new Set<string>();
  /** Blob names found on disk at open; trusted only after their bytes hash to their name. */
  private readonly unverified = new Set<string>();

  private constructor(readonly dir: string) {}

  /** Create the directory layout (0700) and index the blobs already present. */
  static async open(dir: string): Promise<StateFiles> {
    const created = await mkdir(dir, { recursive: true, mode: DIR_MODE });
    if (created !== undefined) await chmod(dir, DIR_MODE); // umask may have narrowed or widened it
    await checkOwned(dir, 'directory');
    const files = new StateFiles(dir);
    const assetsDir = join(dir, ASSETS_DIR);
    try {
      await mkdir(assetsDir, { mode: DIR_MODE });
      await chmod(assetsDir, DIR_MODE);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    await checkOwned(assetsDir, 'directory');
    try {
      await checkOwned(join(dir, STATE_FILE), 'file');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const name of await readdir(assetsDir)) {
      if (SHA256_HEX.test(name)) files.unverified.add(name);
    }
    return files;
  }

  /** The parsed state file, or `undefined` when none exists yet. */
  async readState(): Promise<unknown> {
    let text: string;
    try {
      text = (await readNoFollow(join(this.dir, STATE_FILE))).toString('utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${STATE_FILE} is not valid JSON`);
    }
  }

  async readBlob(hex: string): Promise<Buffer> {
    if (!SHA256_HEX.test(hex)) throw new Error('invalid asset blob name');
    const bytes = await readNoFollow(join(this.dir, ASSETS_DIR, hex));
    if (sha256Hex(bytes) !== hex) throw new Error(`asset blob ${hex} is corrupt`);
    this.unverified.delete(hex);
    this.known.add(hex);
    return bytes;
  }

  /** True when a blob already on disk has exactly the bytes its name promises. */
  private async verified(hex: string): Promise<boolean> {
    if (this.known.has(hex)) return true;
    if (!this.unverified.has(hex)) return false;
    try {
      await this.readBlob(hex);
      return true;
    } catch {
      this.unverified.delete(hex); // corrupt or unreadable: the write below replaces it
      return false;
    }
  }

  /**
   * Persist `blobs` (content-addressed, skipping those already stored) and then replace the state
   * file. Blobs are durable before the state file that references them is renamed into place.
   * Throws `PersistenceError`; `committed` is true only if the failure happened after the rename.
   */
  async write(state: unknown, blobs: Iterable<[string, Uint8Array]>): Promise<void> {
    const text = JSON.stringify(state);
    const assetsDir = join(this.dir, ASSETS_DIR);
    try {
      const written: string[] = [];
      for (const [hex, bytes] of blobs) {
        if (await this.verified(hex)) continue;
        await writeFileAtomic(assetsDir, hex, hex, bytes);
        written.push(hex);
      }
      if (written.length > 0) await fsyncDir(assetsDir);
      for (const hex of written) this.known.add(hex); // only once the directory entry is durable
      await writeFileAtomic(this.dir, STATE_FILE, 'host-state', Buffer.from(text, 'utf8'));
    } catch (e) {
      throw new PersistenceError('could not write host state', false, { cause: e });
    }
    try {
      await fsyncDir(this.dir);
    } catch (e) {
      throw new PersistenceError('could not sync the data directory', true, { cause: e });
    }
  }
}
