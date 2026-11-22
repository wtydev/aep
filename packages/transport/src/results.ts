import { AepError } from '@aep/core';
import { CORE_PROTOCOL } from '@aep/schema';
import type { CoreManifest, CoreResult } from '@aep/schema';

/** A `bad_request` result for input the binding could not parse into a request. */
export function badRequestResult(manifest: CoreManifest, id: string, message: string): CoreResult {
  return {
    protocol: CORE_PROTOCOL,
    session: manifest.session,
    workspace: manifest.workspace,
    id,
    status: 'rejected',
    error: new AepError('bad_request', message).toCoreError(),
  };
}

/**
 * The result a binding returns when its handler throws. The message is fixed so handler
 * internals (paths, stack details) never reach the client.
 */
export function internalErrorResult(manifest: CoreManifest, id: string): CoreResult {
  return {
    protocol: CORE_PROTOCOL,
    session: manifest.session,
    workspace: manifest.workspace,
    id,
    status: 'failed',
    error: new AepError('internal_error', 'internal host error').toCoreError(),
  };
}
