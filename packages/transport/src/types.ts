import type { CoreManifest, CoreRequest, CoreResult, CoreState } from '@aep/schema';

/**
 * Host side of a transport binding. The host engine implements this; bindings feed it raw
 * wire input (`unknown`) so the handler owns envelope, session and params validation.
 */
export interface RequestHandler {
  handle(req: unknown): Promise<CoreResult>;
  manifest(): CoreManifest;
  state(): CoreState;
}

/** Client side of a transport binding: sends CoreRequests, yields results/manifest/state. */
export interface ClientTransport {
  send(req: CoreRequest): Promise<CoreResult>;
  manifest(): Promise<CoreManifest>;
  state(): Promise<CoreState>;
  close(): Promise<void>;
}
