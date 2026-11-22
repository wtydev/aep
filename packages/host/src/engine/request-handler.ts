import type { CoreManifest, CoreResult, CoreState } from '@aep/schema';

/**
 * Structurally identical to `RequestHandler` in `@aep/transport`. Declared here because the host
 * package must not depend on the transport package; TypeScript's structural typing makes an
 * `AepHost` (or `host.forSession(id)`) assignable to the transport's interface.
 */
export interface RequestHandler {
  handle(req: unknown): Promise<CoreResult>;
  manifest(): CoreManifest;
  state(): CoreState;
}
