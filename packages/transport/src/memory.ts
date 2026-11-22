import type { CoreManifest, CoreRequest, CoreResult, CoreState } from '@wty.dev/aep-schema';
import type { ClientTransport, RequestHandler } from './types.js';

const wireCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * In-process transport: calls a RequestHandler directly, deep-copying documents through JSON
 * to emulate the wire (no shared object references between client and host). For tests and
 * embedding.
 */
export class InMemoryTransport implements ClientTransport {
  constructor(private readonly handler: RequestHandler) {}

  async send(req: CoreRequest): Promise<CoreResult> {
    return wireCopy(await this.handler.handle(wireCopy(req)));
  }

  async manifest(): Promise<CoreManifest> {
    return wireCopy(this.handler.manifest());
  }

  async state(): Promise<CoreState> {
    return wireCopy(this.handler.state());
  }

  async close(): Promise<void> {}
}
