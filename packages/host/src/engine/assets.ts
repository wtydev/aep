import { sha256Hex, generateId } from '@aep/core';
import type { Asset, Provenance } from '@aep/schema';

/** Media types `asset.import` accepts. Anything else is `invalid_params`. */
export const IMPORTABLE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'audio/wav',
  'audio/flac',
  'audio/mpeg',
  'audio/ogg',
  'audio/aiff',
  'audio/midi',
]);

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  mid: 'audio/midi',
  midi: 'audio/midi',
};

/** Media type implied by a file name's extension, if any. */
export function mediaTypeFromName(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXTENSION_MEDIA_TYPES[name.slice(dot + 1).toLowerCase()];
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
}

/**
 * Read `sampleRate`, `channels` and duration from a PCM WAV header. Returns `undefined` for
 * anything that is not a well-formed integer-PCM RIFF/WAVE file (compressed, float, malformed).
 */
export function sniffWav(bytes: Uint8Array): WavInfo | undefined {
  if (bytes.length < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let fmt: { channels: number; sampleRate: number; blockAlign: number } | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (declared < 16 || body + 16 > bytes.length) return undefined;
      const format = view.getUint16(body, true);
      if (format !== 1) return undefined; // PCM only
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
      };
    } else if (id === 'data') {
      if (!fmt || fmt.blockAlign === 0 || fmt.sampleRate === 0) return undefined;
      if (fmt.channels < 1 || fmt.channels > 64) return undefined;
      const size = Math.min(declared, bytes.length - body);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        durationSeconds: Math.floor(size / fmt.blockAlign) / fmt.sampleRate,
      };
    }
    offset = body + declared + (declared % 2);
  }
  return undefined;
}

export interface AssetMeta {
  /** Explicit id; must be unused in the store. Default: generated. */
  id?: string;
  name?: string;
  mediaType: string;
  provenance?: Provenance;
  portability?: 'portable' | 'host-local';
}

/** In-memory host asset store (design §9): descriptor + bytes, keyed by asset id. */
export class AssetStore {
  private readonly items = new Map<string, { asset: Asset; bytes: Uint8Array }>();

  /** Register bytes as a new asset. Throws a plain `Error` when an explicit id is taken. */
  put(bytes: Uint8Array, meta: AssetMeta): Asset {
    const id = meta.id ?? generateId('asset');
    if (this.items.has(id)) throw new Error(`asset id '${id}' already exists in the store`);
    const copy = Uint8Array.from(bytes);
    const asset: Asset = {
      id,
      ...(meta.name !== undefined ? { name: meta.name.slice(0, 256) } : {}),
      mediaType: meta.mediaType,
      contentHash: `sha256:${sha256Hex(copy)}`,
      byteLength: copy.byteLength,
      availability: 'available',
      portability: meta.portability ?? 'host-local',
      ...(meta.provenance ? { provenance: meta.provenance } : {}),
    };
    if (meta.mediaType === 'audio/wav') {
      const wav = sniffWav(copy);
      if (wav) {
        asset.sampleRate = wav.sampleRate;
        asset.channels = wav.channels;
        asset.durationSeconds = wav.durationSeconds;
      }
    }
    this.items.set(id, { asset, bytes: copy });
    return structuredClone(asset);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /** Descriptor (a clone) of an available asset. */
  get(id: string): Asset | undefined {
    const item = this.items.get(id);
    return item ? structuredClone(item.asset) : undefined;
  }

  list(): Asset[] {
    return [...this.items.values()].map((i) => structuredClone(i.asset));
  }
}
