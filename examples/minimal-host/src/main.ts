#!/usr/bin/env node
/**
 * aep-reference-host — the AEP reference host as a stand-alone process.
 *
 * Serves one AEP project through the MEP Core 1 stdio or directory binding. Credentials are
 * generated here and written to files (mode 0600); they are never printed and never passed on
 * the command line. Diagnostics go to stderr because stdout is the stdio channel.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AepHost, demoProject, referenceExecutors } from '@aep/host';
import { Project, ROLE_ACTIONS, Scope } from '@aep/schema';
import { DirectoryHostBinding, serveStdio } from '@aep/transport';
import type { RequestHandler } from '@aep/transport';

const USAGE = `Usage: aep-reference-host [options]

  --transport stdio|directory   binding to serve (default stdio)
  --dir <path>                  directory binding: one sub-directory per session under <path>
  --fixture <file>              project JSON to serve (default: built-in demo project)
  --session-config <file>       {"sessions":[{client, role, scope?, allowedActions?, expiresAt?,
                                credentialFile}]}; credentials are written to credentialFile
                                (mode 0600) and <credentialFile>.session.json = {session, workspace}
  --credential-out <file>       without --session-config: one 'edit' session, credential written here
  --import-root <name=path>     directory asset.import may read from (repeatable)
  --executors reference         enable the reference render/generation executors
  --poll-ms <n>                 directory binding poll interval (default 25)
  --verbose                     log start-up information to stderr
  --help                        this text

stdio serves exactly one session (the first); use --transport directory for several.`;

interface SessionConfig {
  client: string;
  role: keyof typeof ROLE_ACTIONS;
  scope?: Scope | undefined;
  allowedActions?: string[] | undefined;
  expiresAt?: number | undefined;
  credentialFile: string;
}

class UsageError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSessionConfig(raw: unknown): SessionConfig[] {
  if (!isRecord(raw) || !Array.isArray(raw.sessions) || raw.sessions.length === 0) {
    throw new UsageError('session config must be {"sessions":[...]} with at least one session');
  }
  return raw.sessions.map((s: unknown, i): SessionConfig => {
    const at = `sessions[${i}]`;
    if (!isRecord(s)) throw new UsageError(`${at} must be an object`);
    if (typeof s.client !== 'string' || s.client.length === 0) {
      throw new UsageError(`${at}.client must be a non-empty string`);
    }
    if (typeof s.role !== 'string' || !Object.hasOwn(ROLE_ACTIONS, s.role)) {
      throw new UsageError(`${at}.role must be one of ${Object.keys(ROLE_ACTIONS).join(', ')}`);
    }
    if (typeof s.credentialFile !== 'string' || s.credentialFile.length === 0) {
      throw new UsageError(`${at}.credentialFile must be a path`);
    }
    if (
      s.allowedActions !== undefined &&
      !(Array.isArray(s.allowedActions) && s.allowedActions.every((a) => typeof a === 'string'))
    ) {
      throw new UsageError(`${at}.allowedActions must be a list of action names`);
    }
    if (s.expiresAt !== undefined && !Number.isFinite(s.expiresAt)) {
      throw new UsageError(`${at}.expiresAt must be epoch milliseconds`);
    }
    const scope = s.scope === undefined ? undefined : Scope.safeParse(s.scope);
    if (scope && !scope.success)
      throw new UsageError(`${at}.scope is invalid: ${scope.error.message}`);
    return {
      client: s.client,
      role: s.role as SessionConfig['role'],
      scope: scope?.data,
      allowedActions: s.allowedActions as string[] | undefined,
      expiresAt: s.expiresAt as number | undefined,
      credentialFile: resolve(s.credentialFile),
    };
  });
}

/** Write `data` with mode 0600 even if the file already existed. */
async function writeSecret(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Atomic write with a unique temp name, so it cannot collide with a binding's own publish. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      transport: { type: 'string', default: 'stdio' },
      dir: { type: 'string' },
      fixture: { type: 'string' },
      'session-config': { type: 'string' },
      'credential-out': { type: 'string' },
      'import-root': { type: 'string', multiple: true },
      executors: { type: 'string' },
      'poll-ms': { type: 'string' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const log = (msg: string): void => {
    if (values.verbose) process.stderr.write(`aep-reference-host: ${msg}\n`);
  };

  const transport = values.transport;
  if (transport !== 'stdio' && transport !== 'directory') {
    throw new UsageError(`--transport must be stdio or directory, got '${transport}'`);
  }
  if (transport === 'directory' && !values.dir)
    throw new UsageError('--transport directory needs --dir <path>');
  if (values.executors !== undefined && values.executors !== 'reference') {
    throw new UsageError(`--executors only supports 'reference', got '${values.executors}'`);
  }
  const pollMs = values['poll-ms'] === undefined ? 25 : Number(values['poll-ms']);
  if (!Number.isFinite(pollMs) || pollMs <= 0)
    throw new UsageError('--poll-ms needs a positive number');

  const importRoots: Record<string, string> = {};
  for (const spec of values['import-root'] ?? []) {
    const eq = spec.indexOf('=');
    if (eq <= 0 || eq === spec.length - 1)
      throw new UsageError(`--import-root needs name=path, got '${spec}'`);
    importRoots[spec.slice(0, eq)] = resolve(spec.slice(eq + 1));
  }

  let configs: SessionConfig[];
  if (values['session-config']) {
    configs = parseSessionConfig(JSON.parse(await readFile(values['session-config'], 'utf8')));
  } else {
    if (!values['credential-out']) {
      throw new UsageError('without --session-config, --credential-out <file> is required');
    }
    configs = [
      {
        client: 'reference-client',
        role: 'edit',
        credentialFile: resolve(values['credential-out']),
      },
    ];
  }

  const project = values.fixture
    ? Project.parse(JSON.parse(await readFile(values.fixture, 'utf8')))
    : demoProject();

  const host = new AepHost({
    project,
    hostInfo: { name: 'aep-reference-host', version: '0.1.0' },
    ...(Object.keys(importRoots).length > 0 ? { importRoots } : {}),
    ...(values.executors === 'reference' ? { executors: referenceExecutors() } : {}),
    onInternalError: (e, req) => {
      process.stderr.write(
        `aep-reference-host: internal error in ${req.action} (${req.id}): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
      );
    },
  });

  const sessions: { id: string; config: SessionConfig }[] = [];
  for (const config of configs) {
    const grant = host.createSession({
      client: config.client,
      role: config.role,
      ...(config.scope ? { scope: config.scope } : {}),
      ...(config.allowedActions ? { allowedActions: config.allowedActions } : {}),
      ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
    });
    await writeSecret(config.credentialFile, `${grant.credential}\n`);
    // The descriptor is written last: its presence means the credential file is complete.
    await writeSecret(
      `${config.credentialFile}.session.json`,
      `${JSON.stringify({ session: grant.session, workspace: grant.workspace })}\n`,
    );
    sessions.push({ id: grant.session, config });
    log(
      `session ${grant.session} (${config.client}, role ${config.role}) -> ${config.credentialFile}`,
    );
  }

  if (transport === 'stdio') {
    const first = sessions[0];
    if (!first) throw new UsageError('no session to serve');
    if (sessions.length > 1) {
      process.stderr.write(
        `aep-reference-host: warning: stdio serves only the first of ${sessions.length} sessions; use --transport directory\n`,
      );
    }
    log(`serving project '${host.projectId}' over stdio, session ${first.id}`);
    await serveStdio({
      handler: host.forSession(first.id),
      input: process.stdin,
      output: process.stdout,
    });
    await host.waitForJobs();
    return;
  }

  // Directory binding: one directory per session. Requests of all sessions are handled one at a
  // time, and after each one the other sessions' state.json is refreshed (a binding only
  // republishes the state of the session whose request it just handled).
  const root = resolve(values.dir as string);
  let queue: Promise<unknown> = Promise.resolve();
  const bindings = new Map<string, DirectoryHostBinding>();
  const refreshOthers = async (except: string): Promise<void> => {
    for (const s of sessions) {
      if (s.id === except) continue;
      await writeAtomic(
        join(root, s.id, 'state.json'),
        JSON.stringify(host.forSession(s.id).state(), null, 2),
      ).catch(() => {});
    }
  };
  for (const s of sessions) {
    const inner = host.forSession(s.id);
    const handler: RequestHandler = {
      manifest: () => inner.manifest(),
      state: () => inner.state(),
      handle: (raw) => {
        const run = queue.then(async () => {
          const result = await inner.handle(raw);
          await refreshOthers(s.id);
          return result;
        });
        queue = run.catch(() => {});
        return run;
      },
    };
    const binding = new DirectoryHostBinding({ dir: join(root, s.id), handler, pollMs });
    await binding.start();
    bindings.set(s.id, binding);
  }
  log(
    `serving project '${host.projectId}' in ${root} (${sessions.length} session director${sessions.length === 1 ? 'y' : 'ies'})`,
  );

  // The bindings' timers are unref'd; keep the process alive until told to stop.
  const keepAlive = setInterval(() => {}, 1 << 30);
  await new Promise<void>((done) => {
    const stop = (): void => done();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  clearInterval(keepAlive);
  await Promise.all([...bindings.values()].map((b) => b.stop()));
  await host.waitForJobs();
}

main().catch((e: unknown) => {
  if (e instanceof UsageError) {
    process.stderr.write(`aep-reference-host: ${e.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`aep-reference-host: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
});
