/**
 * Host launchers: how the suite gets a fresh host (and connected clients) for every test.
 *
 * - {@link InProcessLauncher} runs the reference engine (`@aep/host`) in this process.
 * - {@link ProcessLauncher} spawns any host command that implements the launcher contract
 *   documented in the package README. This is how third-party hosts are tested.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AepClient } from '@aep/client';
import { DirectoryClientTransport, InMemoryTransport, StdioClientTransport } from '@aep/transport';
import type { ClientTransport } from '@aep/transport';
import { Project } from '@aep/schema';
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

/** Runs `@aep/host` in this process, connected through {@link InMemoryTransport}. */
export class InProcessLauncher implements HostLauncher {
  readonly name = 'in-process (@aep/host + in-memory transport)';

  async launch(opts: LaunchOptions): Promise<LaunchedHost> {
    const { AepHost, referenceExecutors } = await import('@aep/host');
    const tmp = await mkdtemp(join(tmpdir(), 'aep-conf-'));
    const inbox = join(tmp, 'inbox');
    await seedInbox(inbox);
    const host = new AepHost({
      project: opts.fixture === undefined ? CONFORMANCE_FIXTURE : Project.parse(opts.fixture),
      importRoots: { inbox },
      executors: referenceExecutors(),
      assertResults: true,
    });
    const clients: AepClient[] = [];
    const credentials: string[] = [];
    for (const [i, spec] of opts.sessions.entries()) {
      const s = host.createSession({
        client: `conformance-${i}`,
        role: spec.role,
        ...(spec.scope ? { scope: spec.scope } : {}),
      });
      credentials.push(s.credential);
      clients.push(
        await AepClient.connect({
          transport: new InMemoryTransport(host.forSession(s.session)),
          credential: s.credential,
        }),
      );
    }
    return {
      clients,
      credentials,
      close: async () => {
        await host.waitForJobs().catch(() => {});
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
        ...(this.options.extraArgs ?? []),
      ];
      child = spawn(this.command, argv, {
        stdio: [multi ? 'ignore' : 'pipe', multi ? 'ignore' : 'pipe', 'pipe'],
        env: { ...process.env, ...this.options.env },
      });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString('utf8')).slice(-2000);
      });
      const proc = child;
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
      if (!multi) {
        if (!proc.stdout || !proc.stdin) throw new Error('host stdio is unavailable');
        const transport = new StdioClientTransport(proc.stdout, proc.stdin);
        transports.push(transport);
        await startup(transport.hello, 'the host hello line');
        await startup(waitForFile(`${credFiles[0]}.session.json`), 'the credential file');
        const credential = (await readFile(credFiles[0] as string, 'utf8')).trim();
        credentials.push(credential);
        clients.push(await startup(AepClient.connect({ transport, credential }), 'the manifest'));
      } else {
        for (const [i, credFile] of credFiles.entries()) {
          await startup(waitForFile(`${credFile}.session.json`), 'the credential files');
          const { session } = JSON.parse(await readFile(`${credFile}.session.json`, 'utf8')) as {
            session: string;
          };
          const sessionDir = join(dir, session);
          await startup(waitForFile(join(sessionDir, 'mep.json')), `the binding of session ${i}`);
          const transport = new DirectoryClientTransport({
            dir: sessionDir,
            pollMs: this.options.pollMs ?? 10,
            timeoutMs: 30_000,
          });
          transports.push(transport);
          const credential = (await readFile(credFile, 'utf8')).trim();
          credentials.push(credential);
          clients.push(await startup(AepClient.connect({ transport, credential }), 'the manifest'));
        }
      }
      return { clients, credentials, close: cleanup };
    } catch (e) {
      await cleanup().catch(() => {});
      throw e;
    }
  }
}
