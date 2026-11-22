import { Project } from '@wty.dev/aep-schema';
import type {
  Asset,
  AutomationLane,
  Clip,
  ControllerEvent,
  Device,
  MeterPoint,
  MidiClip,
  Note,
  PitchBendEvent,
  Section,
  TempoPoint,
  Track,
} from '@wty.dev/aep-schema';
import { AepError } from '@wty.dev/aep-core';
import type { EntityMap, EntityRecord } from '@wty.dev/aep-core';

const clipCompare = (a: { start: number; id: string }, b: { start: number; id: string }): number =>
  a.start - b.start || a.id.localeCompare(b.id);

const noteCompare = (a: Note, b: Note): number =>
  a.start - b.start || a.pitch - b.pitch || a.id.localeCompare(b.id);

const segmentCompare = (
  a: { start: number; id: string },
  b: { start: number; id: string },
): number => a.start - b.start || a.id.localeCompare(b.id);

const set = (
  map: EntityMap,
  path: string,
  entity: EntityRecord['entity'],
  value: unknown,
): void => {
  map.set(path, { entity, value: structuredClone(value) });
};

/**
 * Flatten a project into an `EntityMap` per design §3: id-based entity paths, values without
 * child collections. Exact inverse of `unflattenProject`.
 */
export function flattenProject(project: Project): EntityMap {
  const map: EntityMap = new Map();
  const { tempo, meter, tracks, sections, assets, ...projectValue } = project;
  set(map, '/project', 'project', projectValue);
  set(map, '/tempo', 'tempo', tempo);
  set(map, '/meter', 'meter', meter);
  set(
    map,
    '/trackOrder',
    'trackOrder',
    tracks.map((t) => t.id),
  );
  for (const track of tracks) {
    const tp = `/tracks/${track.id}`;
    const { clips, effects, automation, instrument, ...trackValue } = track;
    set(map, tp, 'track', trackValue);
    if (instrument !== null) set(map, `${tp}/instrument`, 'instrument', instrument);
    set(
      map,
      `${tp}/effectOrder`,
      'effectOrder',
      effects.map((e) => e.id),
    );
    for (const effect of effects) set(map, `${tp}/effects/${effect.id}`, 'effect', effect);
    for (const clip of clips) {
      const cp = `${tp}/clips/${clip.id}`;
      if (clip.type === 'midi') {
        const { notes, controllers, pitchBends, ...clipValue } = clip;
        set(map, cp, 'clip', clipValue);
        for (const note of notes) set(map, `${cp}/notes/${note.id}`, 'note', note);
        set(map, `${cp}/midiEvents`, 'midiEvents', { controllers, pitchBends });
      } else {
        set(map, cp, 'clip', clip);
      }
    }
    for (const lane of automation) {
      set(map, `${tp}/automation/${lane.id}`, 'automationLane', lane);
    }
  }
  for (const section of sections) set(map, `/sections/${section.id}`, 'section', section);
  for (const asset of assets) set(map, `/assets/${asset.id}`, 'asset', asset);
  return map;
}

function missing(path: string): never {
  throw new AepError('validation_failed', `entity map is missing required entity ${path}`);
}

/**
 * Reads an entity map while recording which entities were consumed, so `unflattenProject` can
 * reject maps holding entities that no longer belong anywhere (for example notes of a removed
 * clip left behind by a rebase or undo) instead of dropping them silently.
 */
class MapReader {
  private readonly index = new Map<string, [string, EntityRecord][]>();
  private readonly seen = new Set<string>();

  constructor(private readonly map: EntityMap) {
    // Group every entity under its parent path in one pass, keeping entity-map order.
    for (const entry of map) {
      const parent = entry[0].slice(0, entry[0].lastIndexOf('/'));
      const list = this.index.get(parent);
      if (list) list.push(entry);
      else this.index.set(parent, [entry]);
    }
  }

  at<T>(path: string): T {
    const value = this.optional<T>(path);
    if (value === undefined) missing(path);
    return value;
  }

  optional<T>(path: string): T | undefined {
    const rec = this.map.get(path);
    if (rec) this.seen.add(path);
    return rec?.value as T | undefined;
  }

  /** Direct children of `parent` whose path is exactly one segment deeper. */
  children(parent: string): [string, EntityRecord][] {
    const list = this.index.get(parent) ?? [];
    for (const [path] of list) this.seen.add(path);
    return list;
  }

  /** Throw if any entity was never consumed while rebuilding the project. */
  assertAllConsumed(): void {
    if (this.seen.size === this.map.size) return;
    for (const path of this.map.keys()) {
      if (!this.seen.has(path)) {
        throw new AepError('validation_failed', `entity map has an orphaned entity ${path}`);
      }
    }
  }
}

function unflattenClip(r: MapReader, cp: string, value: Clip): Clip {
  if (value.type !== 'midi') return value;
  const notes = r
    .children(`${cp}/notes`)
    .map(([, rec]) => rec.value as Note)
    .sort(noteCompare);
  const events = r.optional<{ controllers?: ControllerEvent[]; pitchBends?: PitchBendEvent[] }>(
    `${cp}/midiEvents`,
  );
  const midi: MidiClip = {
    ...value,
    notes,
    controllers: events?.controllers ?? [],
    pitchBends: events?.pitchBends ?? [],
  };
  return midi;
}

function unflattenTrack(r: MapReader, tp: string, value: Track): Track {
  const instrument = r.optional<Device>(`${tp}/instrument`) ?? null;
  const effectOrder = r.optional<string[]>(`${tp}/effectOrder`);
  const effectsById = new Map(
    r
      .children(`${tp}/effects`)
      .map(([p, rec]) => [p.slice(p.lastIndexOf('/') + 1), rec.value as Device]),
  );
  const effects: Device[] = effectOrder
    ? effectOrder.map((id) => {
        const d = effectsById.get(id);
        if (!d) missing(`${tp}/effects/${id}`);
        return d;
      })
    : [...effectsById.values()];
  const clips = r
    .children(`${tp}/clips`)
    .map(([p, rec]) => unflattenClip(r, p, rec.value as Clip))
    .sort(clipCompare);
  const automation = r.children(`${tp}/automation`).map(([, rec]) => rec.value as AutomationLane);
  return { ...value, instrument, effects, clips, automation };
}

/**
 * Rebuild a `Project` from an `EntityMap`. Canonical orders: tracks by `/trackOrder`, clips by
 * (start, id), notes by (start, pitch, id), sections by (start, id), assets by id, effects by
 * `/tracks/{t}/effectOrder`. Automation lanes keep entity-map order.
 */
export function unflattenProject(map: EntityMap): Project {
  const r = new MapReader(map);
  const projectValue = r.at<Record<string, unknown>>('/project');
  const tempo = r.at<TempoPoint[]>('/tempo');
  const meter = r.at<MeterPoint[]>('/meter');
  const trackOrder = r.optional<string[]>('/trackOrder');
  const trackPaths = new Map(
    r.children('/tracks').map(([p, rec]) => [p.slice(p.lastIndexOf('/') + 1), rec] as const),
  );
  const order = trackOrder ?? [...trackPaths.keys()];
  const tracks: Track[] = order.map((id) => {
    const rec = trackPaths.get(id);
    if (!rec) missing(`/tracks/${id}`);
    return unflattenTrack(r, `/tracks/${id}`, rec.value as Track);
  });
  // Tolerate tracks missing from trackOrder: append them in path order.
  const ordered = new Set(order);
  for (const [id, rec] of trackPaths) {
    if (!ordered.has(id)) tracks.push(unflattenTrack(r, `/tracks/${id}`, rec.value as Track));
  }
  const sections = r
    .children('/sections')
    .map(([, rec]) => rec.value as Section)
    .sort(segmentCompare);
  const assets = r
    .children('/assets')
    .map(([, rec]) => rec.value as Asset)
    .sort((a, b) => a.id.localeCompare(b.id));
  r.assertAllConsumed();
  const parsed = Project.safeParse({ ...projectValue, tempo, meter, tracks, sections, assets });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AepError(
      'validation_failed',
      `entity map does not reconstruct a valid project: ${issue?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}
