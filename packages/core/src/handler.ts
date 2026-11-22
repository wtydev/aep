import type { CoreManifest, CoreResult, CoreState } from '@wty.dev/aep-schema';

/**
 * Host side of a transport binding. Hosts implement it; transport bindings feed it raw wire
 * input (`unknown`) so the handler owns envelope, session and params validation.
 */
export interface RequestHandler {
  handle(req: unknown): Promise<CoreResult>;
  manifest(): CoreManifest;
  state(): CoreState;
}
