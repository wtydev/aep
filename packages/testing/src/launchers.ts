/**
 * Host launchers: how the suite gets a fresh host (and connected clients) for every test.
 *
 * - {@link InProcessLauncher} runs the reference engine (`@wty.dev/aep-host`) in this process.
 * - {@link ProcessLauncher} spawns any host command that implements the launcher contract
 *   documented in the package README. This is how third-party hosts are tested.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AepClient } from '@wty.dev/aep-client';
import {
  DirectoryClientTransport,
  InMemoryTransport,
  StdioClientTransport,
} from '@wty.dev/aep-transport';
import type { ClientTransport } from '@wty.dev/aep-transport';
import { Project } from '@wty.dev/aep-schema';
import { CONFORMANCE_FIXTURE, standardInbox } from './fixture.js';
import { UnsupportedLaunch } from './suite.js';
import type { HostLauncher, LaunchedHost, LaunchOptions } from './suite.js';

async function seedInbox(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(standardInbox())) {
    await writeFile(join(dir, name), content);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------

/** Runs `@wty.dev/aep-host` in this process, connected through {@link InMemoryTransport}. */
export class InProcessLauncher implements HostLauncher {
  readonly name = 'in-process (@wty.dev/aep-host + in-memory transport)';

  async launch(opts: LaunchOptions): Promise<LaunchedHost> {
    const { AepHost, referenceExecutors } = await import('@wty.dev/aep-host').catch(
      (e: unknown) => {
        throw new Error(
          'the in-process launcher needs the optional peer dependency @wty.dev/aep-host; install it, or pass your host command after "--"',
          { cause: e },
        );
      },
    );
    const tmp = await mkdtemp(join(tmpdir(), 'aep-conf-'));
    const inbox = join(tmp, 'inbox');
    await seedInbox(inbox);
    const project = opts.fixture === undefined ? CONFORMANCE_FIXTURE : Project.parse(opts.fixture);
    const options = { project, importRoots: { inbox }, executors: referenceExecutors() };
    // Restartable hosts are durable (AepHost.open over a data directory); the others are volatile.
    const dataDir = join(tmp, 'data');
    let host = opts.restart
      ? await AepHost.open({ ...options, dataDir, assertResults: true })
      : new AepHost({ ...options, assertResults: true });
    const clients: AepClient[] = [];
    const credentials: string[] = [];
    const sessionIds: string[] = [];
    for (const [i, spec] of opts.sessions.entries()) {
      const s = host.createSession({
        client: `conformance-${i}`,
        role: spec.role,
        ...(spec.scope ? { scope: spec.scope } : {}),
      });
      credentials.push(s.credential);
      sessionIds.push(s.session);
    }
    await host.flush();
    const connect = async (): Promise<void> => {
      for (const [i, session] of sessionIds.entries()) {
        clients[i] = await AepClient.connect({
          transport: new InMemoryTransport(host.forSession(session)),
          credential: credentials[i] as string,
        });
      }
    };
    await connect();
    return {
      clients,
      credentials,
      ...(opts.restart
        ? {
            restart: async (): Promise<void> => {
              // An in-process host cannot be killed; settle its writes and drop it.
              await host.waitForJobs().catch(() => {});
              await host.flush();
              host = await AepHost.open({ ...options, dataDir, assertResults: true });
              await connect();
            },
          }
        : {}),
      close: async () => {
        await host.waitForJobs().catch(() => {});
        await host.flush().catch(() => {});
        await rm(tmp, { recursive: true, force: true });
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------

export interface ProcessLauncherOptions {
  /** Extra arguments appended after the standard ones. */
  extraArgs?: string[];
  /** Extra environment variables for the host process. */
  env?: Record<string, string>;
  /**
   * Use the directory binding to serve tests that need more than one session. Default true. With
   * false such tests are skipped (a host that can only bind one session over stdio).
   */
  multiSession?: boolean;
  /**
   * The host implements `--data-dir` (durable state) and can be killed and started again over the
   * same directory. Enables the `durability` level. Default true; a host that does not implement
   * `--data-dir` is detected by the capability probe (it fails to start with the flag), and the
   * durability tests are skipped. Set false to never pass `--data-dir`.
   */
  restart?: boolean;
  /** How long to wait for the host to publish its credentials and manifest. Default 15 s. */
  startupTimeoutMs?: number;
  /** Poll interval of the directory client transport. Default 10 ms. */
  pollMs?: number;
}

/**
 * Spawns `command ...args` for every test (see the README for the contract):
 *
 * ```
 * <command> <args> --transport stdio|directory [--dir <dir>] --fixture <file>
 *           --session-config <file> --import-root inbox=<dir> --executors reference
 * ```
 *
 * One session is served over stdio. Several sessions are served over the directory binding, one
 * sub-directory per session under `--dir`.
 *
 * Unless `restart: false` the launcher adds `--data-dir <dir>` and can restart the host: SIGKILL, then the
 * identical command line again (single stdio session only).
 */
export class ProcessLauncher implements HostLauncher {
  readonly name: string;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly options: ProcessLauncherOptions = {},
  ) {
    this.name = `process: ${[command, ...args].join(' ')}`;
  }

  async launch(opts: LaunchOptions): Promise<LaunchedHost> {
    const multi = opts.sessions.length > 1;
    if (multi && this.options.multiSession === false) {
      throw new UnsupportedLaunch('launcher is configured for single-session hosts');
    }
    if (opts.restart && (this.options.restart === false || multi)) {
      throw new UnsupportedLaunch(
        multi
          ? 'restart is supported for one stdio session only'
          : 'launcher has no restart support',
      );
    }
    const timeoutMs = this.options.startupTimeoutMs ?? 15_000;
    const tmp = await mkdtemp(join(tmpdir(), 'aep-conf-'));
    let child: ChildProcess | undefined;
    const transports: ClientTransport[] = [];
    const cleanup = async (): Promise<void> => {
      await Promise.all(transports.map((t) => t.close().catch(() => {})));
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
        child.kill('SIGTERM');
        const killer = setTimeout(() => child?.kill('SIGKILL'), 2_000);
        await exited;
        clearTimeout(killer);
      }
      await rm(tmp, { recursive: true, force: true });
    };

    try {
      const fixtureFile = join(tmp, 'fixture.json');
      const inbox = join(tmp, 'inbox');
      const configFile = join(tmp, 'session-config.json');
      const credFiles = opts.sessions.map((_, i) => join(tmp, `session-${i}.credential`));
      await writeFile(
        fixtureFile,
        JSON.stringify(opts.fixture === undefined ? CONFORMANCE_FIXTURE : opts.fixture),
      );
      await seedInbox(inbox);
      await writeFile(
        configFile,
        JSON.stringify({
          sessions: opts.sessions.map((s, i) => ({
            client: `conformance-${i}`,
            role: s.role,
            ...(s.scope ? { scope: s.scope } : {}),
            credentialFile: credFiles[i],
          })),
        }),
      );

      const dir = join(tmp, 'dir');
      const argv = [
        ...this.args,
        '--transport',
        multi ? 'directory' : 'stdio',
        ...(multi ? ['--dir', dir] : []),
        '--fixture',
        fixtureFile,
        '--session-config',
        configFile,
        '--import-root',
        `inbox=${inbox}`,
        '--executors',
        'reference',
        ...(opts.restart ? ['--data-dir', join(tmp, 'data')] : []),
        ...(this.options.extraArgs ?? []),
      ];
      const exists = async (path: string): Promise<boolean> =>
        access(path).then(
          () => true,
          () => false,
        );
      const waitForFile = async (path: string): Promise<void> => {
        while (!(await exists(path))) await sleep(20);
      };

      const clients: AepClient[] = [];
      const credentials: string[] = [];

      /** Spawn the host and (re)connect every session; fills `clients` / `credentials` in place. */
      const startHost = async (): Promise<void> => {
        const proc = spawn(this.command, argv, {
          stdio: [multi ? 'ignore' : 'pipe', multi ? 'ignore' : 'pipe', 'pipe'],
          env: { ...process.env, ...this.options.env },
        });
        child = proc;
        let stderr = '';
        proc.stderr?.on('data', (d: Buffer) => {
          stderr = (stderr + d.toString('utf8')).slice(-2000);
        });
        const dead = new Promise<never>((_, reject) => {
          proc.once('error', (e) => reject(new Error(`cannot start host: ${e.message}`)));
          proc.once('exit', (code, signal) =>
            reject(
              new Error(
                `host exited during startup (${signal ?? `code ${code}`})${stderr ? `: ${stderr.trim()}` : ''}`,
              ),
            ),
          );
        });
        dead.catch(() => {});
        const startup = async <T>(p: Promise<T>, what: string): Promise<T> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `timed out after ${timeoutMs} ms waiting for ${what}${stderr ? `: ${stderr.trim()}` : ''}`,
                  ),
                ),
              timeoutMs,
            );
          });
          try {
            return await Promise.race([p, dead, timeout]);
          } finally {
            clearTimeout(timer);
          }
        };

        if (!multi) {
          if (!proc.stdout || !proc.stdin) throw new Error('host stdio is unavailable');
          const transport = new StdioClientTransport(proc.stdout, proc.stdin);
          transports.push(transport);
          await startup(transport.hello, 'the host hello line');
          await startup(waitForFile(`${credFiles[0]}.session.json`), 'the credential file');
          const credential = (await readFile(credFiles[0] as string, 'utf8')).trim();
          credentials[0] = credential;
          clients[0] = await startup(AepClient.connect({ transport, credential }), 'the manifest');
        } else {
          for (const [i, credFile] of credFiles.entries()) {
            await startup(waitForFile(`${credFile}.session.json`), 'the credential files');
            const { session } = JSON.parse(await readFile(`${credFile}.session.json`, 'utf8')) as {
              session: string;
            };
            const sessionDir = join(dir, session);
            await startup(waitForFile(join(sessionDir, 'aep.json')), `the binding of session ${i}`);
            const transport = new DirectoryClientTransport({
              dir: sessionDir,
              pollMs: this.options.pollMs ?? 10,
              timeoutMs: 30_000,
            });
            transports.push(transport);
            const credential = (await readFile(credFile, 'utf8')).trim();
            credentials[i] = credential;
            clients[i] = await startup(
              AepClient.connect({ transport, credential }),
              'the manifest',
            );
          }
        }
      };

      /**
       * SIGKILL the host: a crash, not a shutdown. Kill and reap it before closing transports, so
       * the host never sees EOF on stdin (or a closed binding) and gets a chance to exit cleanly.
       */
      const killHost = async (): Promise<void> => {
        const proc = child;
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
          proc.kill('SIGKILL');
          await exited;
        }
        await Promise.all(transports.splice(0).map((t) => t.close().catch(() => {})));
      };

      await startHost();
      return {
        clients,
        credentials,
        ...(opts.restart
          ? {
              restart: async (): Promise<void> => {
                await killHost();
                await startHost();
              },
            }
          : {}),
        close: cleanup,
      };
    } catch (e) {
      await cleanup().catch(() => {});
      throw e;
    }
  }
}
