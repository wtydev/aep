import type { CoreManifest, CoreRequest, CoreResult, CoreState } from '@wty.dev/aep-schema';

export type { RequestHandler } from '@wty.dev/aep-core';

/** Client side of a transport binding: sends CoreRequests, yields results/manifest/state. */
export interface ClientTransport {
  send(req: CoreRequest): Promise<CoreResult>;
  manifest(): Promise<CoreManifest>;
  state(): Promise<CoreState>;
  close(): Promise<void>;
}
