import type { Change, EntityKind, Project } from '@aep/schema';
import { diffEntities } from '@aep/core';
import { flattenProject } from './flatten.js';

/** Diff two project states as entity changes (receipts, scope checks, proposals, history). */
export function projectDiff(before: Project, after: Project): Change[] {
  return diffEntities(flattenProject(before), flattenProject(after));
}

const ID_BEARING: ReadonlySet<EntityKind> = new Set([
  'track',
  'clip',
  'note',
  'effect',
  'instrument',
  'automationLane',
  'section',
  'asset',
]);

/**
 * Id lists for receipts: last path segment of each add/remove change whose entity kind carries
 * an id (project-level entities like `/tempo` contribute nothing).
 */
export function createdRemoved(changes: readonly Change[]): {
  created: string[];
  removed: string[];
} {
  const created: string[] = [];
  const removed: string[] = [];
  for (const change of changes) {
    if (!ID_BEARING.has(change.entity)) continue;
    // Instruments live at `/tracks/{tid}/instrument`; their id is the device id, not the segment.
    const id =
      change.entity === 'instrument'
        ? ((change.after ?? change.before) as { id: string }).id
        : change.path.slice(change.path.lastIndexOf('/') + 1);
    if (change.kind === 'add') created.push(id);
    else if (change.kind === 'remove') removed.push(id);
  }
  return { created, removed };
}
