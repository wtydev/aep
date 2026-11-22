import type { Diagnostic, Id, Limits, MeterPoint, Project, TempoPoint } from '@aep/schema';
import { hasRoutingCycle, trackAcceptsClip } from './apply.js';

/**
 * Project invariants checked after applying a transaction's operations (design §4). Returns
 * one diagnostic per violation; an empty list means the state is committable.
 */
export function validateInvariants(project: Project, limits: Limits): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const d = (message: string, path?: string): void => {
    diagnostics.push({
      code: 'invariant_violation',
      message,
      ...(path !== undefined ? { path } : {}),
    });
  };

  // Unique ids per id space.
  const checkSpace = (what: string, ids: Iterable<Id>, pathFor: (id: Id) => string): Set<Id> => {
    const seen = new Set<Id>();
    for (const id of ids) {
      if (seen.has(id)) d(`duplicate ${what} id '${id}'`, pathFor(id));
      seen.add(id);
    }
    return seen;
  };

  const trackIds = checkSpace(
    'track',
    project.tracks.map((t) => t.id),
    (id) => `/tracks/${id}`,
  );
  const clipIds: [Id, string][] = [];
  const deviceIds: [Id, string][] = [];
  const laneIds: [Id, string][] = [];
  for (const t of project.tracks) {
    for (const c of t.clips) clipIds.push([c.id, `/tracks/${t.id}/clips/${c.id}`]);
    if (t.instrument) deviceIds.push([t.instrument.id, `/tracks/${t.id}/instrument`]);
    for (const e of t.effects) deviceIds.push([e.id, `/tracks/${t.id}/effects/${e.id}`]);
    for (const l of t.automation) laneIds.push([l.id, `/tracks/${t.id}/automation/${l.id}`]);
  }
  const checkPairs = (what: string, pairs: [Id, string][]): void => {
    const seen = new Set<Id>();
    for (const [id, path] of pairs) {
      if (seen.has(id)) d(`duplicate ${what} id '${id}'`, path);
      seen.add(id);
    }
  };
  checkPairs('clip', clipIds);
  checkPairs('device', deviceIds);
  checkPairs('automation lane', laneIds);
  checkSpace(
    'section',
    project.sections.map((s) => s.id),
    (id) => `/sections/${id}`,
  );
  checkSpace(
    'asset',
    project.assets.map((a) => a.id),
    (id) => `/assets/${id}`,
  );

  // Note ids unique within each clip.
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.type !== 'midi') continue;
      const seen = new Set<Id>();
      for (const n of c.notes) {
        if (seen.has(n.id)) {
          d(`duplicate note id '${n.id}' in clip '${c.id}'`, `/tracks/${t.id}/clips/${c.id}`);
        }
        seen.add(n.id);
      }
    }
  }

  // Tempo/meter maps sorted, starting at 0, without duplicate positions.
  const checkMap = (
    points: readonly { position: number }[],
    what: string,
    unit: string,
    path: string,
  ): void => {
    if (points.length === 0 || points[0]!.position !== 0) {
      d(`${what} map must start at ${unit} 0`, path);
    }
    for (let i = 1; i < points.length; i++) {
      if (points[i]!.position === points[i - 1]!.position) {
        d(`${what} map has a duplicate ${unit} position ${points[i]!.position}`, path);
      } else if (points[i]!.position < points[i - 1]!.position) {
        d(`${what} map must be sorted by ${unit}`, path);
      }
    }
  };
  checkMap(
    project.tempo.map((p: TempoPoint) => ({ position: p.beat })),
    'tempo',
    'beat',
    '/tempo',
  );
  checkMap(
    project.meter.map((p: MeterPoint) => ({ position: p.bar })),
    'meter',
    'bar',
    '/meter',
  );

  // Clips: audio clips reference project assets and live on compatible tracks.
  const assetIds = new Set(project.assets.map((a) => a.id));
  for (const t of project.tracks) {
    for (const c of t.clips) {
      const path = `/tracks/${t.id}/clips/${c.id}`;
      if (c.type === 'audio' && !assetIds.has(c.assetId)) {
        d(`clip '${c.id}' references asset '${c.assetId}' missing from project.assets`, path);
      }
      if (!trackAcceptsClip(t.kind, c.type)) {
        d(`'${c.type}' clip '${c.id}' lives on incompatible '${t.kind}' track '${t.id}'`, path);
      }
      if (c.type === 'midi' && c.notes.length > limits.maxNotesPerClip) {
        d(`clip '${c.id}' has ${c.notes.length} notes, above maxNotesPerClip`, path);
      }
    }
  }

  // Device assetIds resolve to project assets.
  for (const t of project.tracks) {
    const devices = [...(t.instrument ? [t.instrument] : []), ...t.effects];
    for (const device of devices) {
      if (device.assetId !== undefined && !assetIds.has(device.assetId)) {
        d(
          `device '${device.id}' references asset '${device.assetId}' missing from project.assets`,
          `/tracks/${t.id}`,
        );
      }
    }
  }

  // parentId exists and forms no cycle.
  const parent = new Map(project.tracks.map((t) => [t.id, t.parentId] as const));
  for (const t of project.tracks) {
    if (t.parentId !== null && !trackIds.has(t.parentId)) {
      d(`track '${t.id}' has unknown parent '${t.parentId}'`, `/tracks/${t.id}`);
    }
  }
  for (const t of project.tracks) {
    const seen = new Set<Id>([t.id]);
    let cur = t.parentId;
    while (cur !== null) {
      if (seen.has(cur)) {
        d(`track '${t.id}' is inside a parentId cycle`, `/tracks/${t.id}`);
        break;
      }
      seen.add(cur);
      const next = parent.get(cur);
      if (next === undefined) break; // missing parent already reported
      cur = next;
    }
  }

  // Routing targets valid and acyclic.
  const byId = new Map(project.tracks.map((t) => [t.id, t] as const));
  for (const t of project.tracks) {
    const path = `/tracks/${t.id}`;
    if (t.output !== 'master') {
      const target = byId.get(t.output);
      if (!target) d(`track '${t.id}' outputs to unknown track '${t.output}'`, path);
      else if (target.id === t.id) d(`track '${t.id}' outputs to itself`, path);
      else if (target.kind !== 'bus') {
        d(`track '${t.id}' outputs to '${target.kind}' track '${target.id}', must be a bus`, path);
      }
    }
    for (const s of t.sends) {
      const target = byId.get(s.targetTrackId);
      if (!target) {
        d(`track '${t.id}' sends to unknown track '${s.targetTrackId}'`, path);
      } else if (target.id === t.id) {
        d(`track '${t.id}' sends to itself`, path);
      } else if (target.kind !== 'bus') {
        d(`track '${t.id}' sends to '${target.kind}' track '${target.id}', must be a bus`, path);
      }
    }
  }
  if (hasRoutingCycle(project)) d('routing graph contains a cycle');

  if (project.tracks.length > limits.maxTracks) {
    d(`project has ${project.tracks.length} tracks, above maxTracks (${limits.maxTracks})`);
  }

  return diagnostics;
}
