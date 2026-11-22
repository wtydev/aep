import { z } from 'zod';

/** AEP protocol version implemented by this schema package. */
export const PROTOCOL_VERSION = '0.1' as const;
/** Schema version (semver). Bumps on any schema change; major tracks protocol major before 1.0. */
export const SCHEMA_VERSION = '0.1.0' as const;

/**
 * Stable identifier for any AEP entity. Opaque to clients; hosts MUST keep ids stable across
 * revisions. Restricted charset keeps ids safe in JSON pointers, file names and logs.
 */
export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'id must match ^[A-Za-z0-9][A-Za-z0-9._:-]*$');
export type Id = z.infer<typeof Id>;

/** Opaque revision identifier. Clients MUST NOT parse it or assume ordering. */
export const RevisionId = z.string().min(1).max(128);
export type RevisionId = z.infer<typeof RevisionId>;

/**
 * Namespaced extension key: reverse-DNS style (`com.example.feature`). The `aep.` prefix is
 * reserved for this specification.
 */
export const ExtensionKey = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/,
    'extension keys must be reverse-DNS namespaced',
  );

/** Container for vendor data. Hosts MUST preserve extension data they do not understand. */
export const Extensions = z.record(ExtensionKey, z.unknown());
export type Extensions = z.infer<typeof Extensions>;

export const finite = () => z.number().finite();
export const nonNegative = () => z.number().finite().min(0);
export const positive = () => z.number().finite().positive();

/** Gain in decibels. -144 dB is treated as silence. */
export const GainDb = z.number().finite().min(-144).max(24);
/** Stereo pan, -1 = hard left, 0 = centre, +1 = hard right. */
export const Pan = z.number().finite().min(-1).max(1);

/**
 * Timebase of a timeline object.
 * - `beats`: musical time, quarter-note beats from project start. Follows the tempo map.
 * - `seconds`: absolute time. Does not move when the tempo map changes.
 */
export const Timebase = z.enum(['beats', 'seconds']);
export type Timebase = z.infer<typeof Timebase>;

/** Unit accepted where a client expresses a time range (e.g. scopes, render regions). */
export const TimeUnit = z.enum(['beats', 'seconds', 'samples']);
export type TimeUnit = z.infer<typeof TimeUnit>;

export const TimeRange = z
  .strictObject({ start: nonNegative(), end: nonNegative(), unit: TimeUnit })
  .refine((r) => r.end > r.start, { message: 'end must be greater than start' });
export type TimeRange = z.infer<typeof TimeRange>;

/** A primitive device / instrument parameter value. */
export const ParamValue = z.union([z.number().finite(), z.string().max(1024), z.boolean()]);
export type ParamValue = z.infer<typeof ParamValue>;
