import { CORE_PROTOCOL, CoreRequest, sanitizeRequestId } from '@aep/schema';
import type { CoreManifest, CoreResult, CoreState } from '@aep/schema';
import { badRequestResult } from './results.js';
import type { RequestHandler } from './types.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fake RequestHandler for transport/client tests. Returns `succeeded` with
 * `output = {echo: params}` and `revision = 'rev-1'`, remembers each request id so a resent
 * id yields the identical stored result (idempotency), honours `params.delayMs` (to force
 * out-of-order stdio results), and rejects action `boom` (or `*.boom`) with `bad_request`.
 */
export class FakeHandler implements RequestHandler {
  readonly session = 'sess-test';
  readonly workspace = 'ws-test';
  private readonly results = new Map<string, CoreResult>();

  async handle(req: unknown): Promise<CoreResult> {
    const parsed = CoreRequest.safeParse(req);
    if (!parsed.success) {
      const id = sanitizeRequestId((req as { id?: unknown } | null)?.id);
      return badRequestResult(this.manifest(), id, 'malformed request envelope');
    }
    const r = parsed.data;
    const stored = this.results.get(r.id);
    if (stored) return stored;
    const delay = typeof r.params.delayMs === 'number' ? r.params.delayMs : 0;
    if (delay > 0) await sleep(delay);
    const result: CoreResult =
      r.action === 'boom' || r.action.endsWith('.boom')
        ? {
            protocol: CORE_PROTOCOL,
            session: r.session,
            workspace: r.workspace,
            id: r.id,
            status: 'rejected',
            error: { code: 'bad_request', next: 'fix', message: 'boom' },
          }
        : {
            protocol: CORE_PROTOCOL,
            session: r.session,
            workspace: r.workspace,
            id: r.id,
            status: 'succeeded',
            revision: 'rev-1',
            output: { echo: r.params },
          };
    this.results.set(r.id, result);
    return result;
  }

  manifest(): CoreManifest {
    return {
      protocol: CORE_PROTOCOL,
      session: this.session,
      workspace: this.workspace,
      expiresAt: Date.now() + 3_600_000,
      actions: [
        {
          id: 'test.echo',
          version: 1,
          effect: 'read',
          paramsSchema: 'schemas/test-echo-params.schema.json',
          resultSchema: 'schemas/test-echo-result.schema.json',
        },
      ],
      stateSchema: 'schemas/state.schema.json',
    };
  }

  state(): CoreState {
    return {
      protocol: CORE_PROTOCOL,
      session: this.session,
      workspace: this.workspace,
      revision: 'rev-1',
      data: { fake: true },
    };
  }
}
