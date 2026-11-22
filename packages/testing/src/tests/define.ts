import type { ConformanceTest, Level, SessionSpec } from '../suite.js';
import type { TestContext } from '../context.js';

export interface TestOptions {
  requires?: string[];
  sessions?: SessionSpec[];
  fixture?: unknown;
  restart?: boolean;
}

/** `def('core')('envelope.unknown-action', 'title', async (ctx) => …)` → a registered-ready test. */
export function defineLevel(level: Level) {
  return (
    area: string,
    title: string,
    run: (ctx: TestContext) => Promise<void>,
    opts: TestOptions = {},
  ): ConformanceTest => ({
    id: `${level}.${area}`,
    title,
    level,
    ...(opts.requires ? { requires: opts.requires } : {}),
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
    ...(opts.fixture !== undefined ? { fixture: opts.fixture } : {}),
    ...(opts.restart ? { restart: true } : {}),
    run,
  });
}

export const ADMIN: SessionSpec[] = [{ role: 'admin' }];
