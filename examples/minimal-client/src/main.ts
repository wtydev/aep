#!/usr/bin/env node
/**
 * aep-demo-client — walks through the AEP protocol against the reference host.
 *
 * The host runs as an independent process (examples/minimal-host). The session credential is
 * handed over through a temp file (mode 0600) and is never printed. Every step states what it
 * expects; any deviation aborts with a non-zero exit code.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AepClient } from '@aep/client';
import type { Job } from '@aep/schema';
import { DirectoryClientTransport, StdioClientTransport } from '@aep/transport';
import type { ClientTransport } from '@aep/transport';

const USAGE = `Usage: aep-demo-client [--transport stdio|directory] [--host <path to host main.js>]

Spawns the reference host as a separate process and runs a scripted protocol tour.`;

class DemoFailure extends Error {}

let stepNo = 0;
const say = (msg = ''): void => {
  process.stdout.write(`${msg}\n`);
};
const step = async (title: string, body: () => Promise<void>): Promise<void> => {
  stepNo += 1;
  say(`\n[${stepNo}] ${title}`);
  await body();
};
const expect = (cond: unknown, what: string): void => {
  if (!cond) throw new DemoFailure(`expectation failed: ${what}`);
  say(`    ok: ${what}`);
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The operations are plain JSON; the host validates them. */
const ops = (...operations: unknown[]) => ({ operations: operations as never });

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      transport: { type: 'string', default: 'stdio' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    say(USAGE);
    return;
  }
  if (values.transport !== 'stdio' && values.transport !== 'directory') {
    throw new DemoFailure(`--transport must be stdio or directory, got '${values.transport}'`);
  }
  const hostMain =
    values.host ?? fileURLToPath(new URL('../../minimal-host/dist/main.js', import.meta.url));
  await access(hostMain).catch(() => {
    throw new DemoFailure(`reference host not built: ${hostMain} (run 'pnpm build')`);
  });

  const tmp = await mkdtemp(join(tmpdir(), 'aep-demo-'));
  const credentialFile = join(tmp, 'credential');
  const common = [hostMain, '--credential-out', credentialFile, '--executors', 'reference'];
  let transport: ClientTransport | undefined;
  let child: ChildProcess | undefined;

  try {
    if (values.transport === 'stdio') {
      const stdio = StdioClientTransport.spawn('node', [...common, '--transport', 'stdio']);
      await stdio.hello;
      transport = stdio;
    } else {
      const dir = join(tmp, 'dir');
      child = spawn('node', [...common, '--transport', 'directory', '--dir', dir], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const exited = new Promise<never>((_, reject) =>
        child?.once('exit', (code) => reject(new DemoFailure(`host exited early (code ${code})`))),
      );
      exited.catch(() => {});
      const ready = (async () => {
        for (;;) {
          try {
            const { session } = JSON.parse(
              await readFile(`${credentialFile}.session.json`, 'utf8'),
            ) as { session: string };
            await access(join(dir, session, 'mep.json'));
            return join(dir, session);
          } catch {
            await sleep(25);
          }
        }
      })();
      transport = new DirectoryClientTransport({
        dir: await Promise.race([ready, exited]),
        pollMs: 10,
      });
    }

    const credential = (await readFile(credentialFile, 'utf8')).trim();
    const client = await AepClient.connect({ transport, credential });
    say(
      `Connected over ${values.transport} (session ${client.session}, workspace ${client.workspace}).`,
    );

    await tour(client, values.transport);
    say('\ndemo complete: every step behaved as expected.');
  } finally {
    await transport?.close().catch(() => {});
    if (child && child.exitCode === null) {
      const gone = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await gone;
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

async function tour(client: AepClient, binding: 'stdio' | 'directory'): Promise<void> {
  await step('aep.capabilities — what does this host offer?', async () => {
    const caps = await client.capabilities();
    say(`    host: ${caps.host.name} ${caps.host.version}; protocol ${caps.aep.protocolVersion}`);
    say(
      `    role: ${caps.session.role}; capabilities: ${Object.keys(caps.capabilities).join(', ')}`,
    );
    expect(caps.session.role === 'edit', 'the session has the edit role');
    expect(
      caps.capabilities['aep.proposals'] && caps.capabilities['aep.history'],
      'proposals and history are offered',
    );
    expect(
      caps.capabilities['aep.render'] && caps.capabilities['aep.jobs'],
      'rendering and jobs are offered',
    );
  });

  await step('project.inspect — read the project', async () => {
    const { revision, project } = await client.inspect();
    say(
      `    "${project.name}" at ${revision}: ${project.tracks.map((t) => `${t.name} (${t.kind})`).join(', ')}`,
    );
    expect(project.tracks.length === 3, 'the demo project has 3 tracks');
  });

  await step(
    'transaction.commit — add a MIDI track with a clip and notes (one atomic transaction)',
    async () => {
      const receipt = await client.commit({
        label: 'Add lead',
        ...ops(
          { op: 'track.add', track: { id: 't-lead', name: 'Lead', kind: 'midi' } },
          {
            op: 'clip.insert',
            trackId: 't-lead',
            clip: {
              id: 'c-lead',
              type: 'midi',
              name: 'Hook',
              start: 0,
              duration: 4,
              timebase: 'beats',
            },
          },
          {
            op: 'midi.notes.add',
            clipId: 'c-lead',
            notes: [60, 64, 67, 72].map((pitch, i) => ({
              id: `ln${i + 1}`,
              pitch,
              start: i,
              duration: 1,
              velocity: 96,
            })),
          },
        ),
      });
      say(
        `    receipt ${receipt.transactionId}: ${receipt.baseRevision} -> ${receipt.revision}, ${receipt.operationCount} operations`,
      );
      for (const c of receipt.changes)
        say(`      ${c.kind.padEnd(6)} ${c.entity.padEnd(8)} ${c.path}`);
      expect(receipt.revision !== receipt.baseRevision, 'the revision advanced');
      expect(receipt.created.length >= 3, `created: ${receipt.created.join(', ')}`);
      const { project } = await client.inspect();
      const lead = project.tracks.find((t) => t.id === 't-lead');
      expect(
        lead?.clips[0]?.type === 'midi' && lead.clips[0].notes.length === 4,
        'the clip holds 4 notes',
      );
    },
  );

  let proposalId = '';
  await step('proposal.create / proposal.get — suggest a change without applying it', async () => {
    const proposal = await client.propose({
      label: 'Rename the piano',
      ...ops({ op: 'track.update', trackId: 't-midi', patch: { name: 'Grand Piano' } }),
    });
    proposalId = proposal.id;
    say(
      `    proposal ${proposal.id} is ${proposal.status}, base ${proposal.baseRevision}, ${proposal.changes.length} change(s)`,
    );
    const got = await client.call('proposal.get', { proposalId });
    expect(got.proposal.status === 'open', 'proposal.get shows it open');
    const { project } = await client.inspect();
    expect(
      project.tracks.find((t) => t.id === 't-midi')?.name === 'Keys',
      'the project is not changed by a proposal',
    );
  });

  await step('proposal.accept — apply it', async () => {
    const receipt = await client.acceptProposal(proposalId);
    say(`    accepted as ${receipt.transactionId} (${receipt.kind}), now ${receipt.revision}`);
    const { project } = await client.inspect();
    expect(
      project.tracks.find((t) => t.id === 't-midi')?.name === 'Grand Piano',
      'the track is renamed',
    );
  });

  await step('history.undo / history.redo', async () => {
    const undo = await client.undo();
    say(`    undo -> ${undo.revision} (undid ${undo.targetTransactionId})`);
    expect(
      (await client.inspect()).project.tracks.find((t) => t.id === 't-midi')?.name === 'Keys',
      'undo restored the name',
    );
    const redo = await client.redo();
    say(`    redo -> ${redo.revision}`);
    expect(
      (await client.inspect()).project.tracks.find((t) => t.id === 't-midi')?.name ===
        'Grand Piano',
      'redo re-applied the rename',
    );
    const h = await client.history();
    expect(h.entries.length >= 4 && h.canUndo, `history has ${h.entries.length} entries`);
  });

  await step(
    'render.request + job.status — asynchronous work, results land in the host asset store',
    async () => {
      const before = (await client.inspect()).revision;
      const { job } = await client.renderRequest({ target: 'mix', format: { container: 'wav' } });
      say(`    job ${job.id} is ${job.state}`);
      const done: Job = await client.waitForJob(job.id, { timeoutMs: 15_000 });
      say(`    job ${done.id} finished: ${done.state}`);
      expect(done.state === 'succeeded', 'the render job succeeded');
      const store = await client.call('asset.list', { store: true });
      say(`    host store: ${store.assets.map((a) => `${a.id} (${a.mediaType})`).join(', ')}`);
      expect(
        (done.result?.assets ?? []).every((a) => store.assets.some((s) => s.id === a.id)),
        'render output is in the host store',
      );
      expect((await client.inspect()).revision === before, 'rendering does not change the project');
    },
  );

  await step(
    'idempotency — retrying the same request id returns the identical result',
    async () => {
      const base = (await client.inspect()).revision;
      const entriesBefore = (await client.history()).entries.length;
      const params = {
        transaction: ops({ op: 'track.update', trackId: 't-bus', patch: { name: 'Mix Bus' } }),
      };
      const first = await client.request('transaction.commit', params, {
        id: 'demo-retry-1',
        baseRevision: base,
      });
      const second = await client.request('transaction.commit', params, {
        id: 'demo-retry-1',
        baseRevision: base,
      });
      say(`    first:  ${first.status} ${first.revision}`);
      say(`    second: ${second.status} ${second.revision}`);
      expect(first.status === 'succeeded', 'the first request succeeded');
      expect(JSON.stringify(first) === JSON.stringify(second), 'the replay is byte-identical');
      expect(
        (await client.history()).entries.length === entriesBefore + 1,
        'the commit was applied exactly once',
      );
      if (binding === 'directory') {
        // The directory binding names result files after the request id, so a reused id reads the
        // earlier result file instead of reaching the host: id_conflict is only observable on stdio.
        say('    (skipped on the directory binding: result files are keyed by request id)');
      } else {
        const different = await client.request(
          'transaction.commit',
          { transaction: ops({ op: 'track.update', trackId: 't-bus', patch: { name: 'Other' } }) },
          { id: 'demo-retry-1', baseRevision: base },
        );
        expect(
          different.status === 'rejected' && different.error?.code === 'id_conflict',
          'reusing the id for a different request is id_conflict',
        );
      }
    },
  );

  await step('scope — a transaction scope confines what an edit may touch', async () => {
    const before = await client.inspect();
    const result = await client.request(
      'transaction.commit',
      {
        transaction: {
          scope: { clips: ['c-lead'] },
          ...ops({ op: 'clip.update', clipId: 'c-midi', patch: { name: 'Sneaky' } }),
        },
      },
      { id: 'demo-scope-1', baseRevision: before.revision },
    );
    say(`    status ${result.status}, error ${result.error?.code} (next: ${result.error?.next})`);
    expect(
      result.status === 'rejected' && result.error?.code === 'scope_violation',
      'the commit is rejected with scope_violation',
    );
    const receipt = await client.receipt('demo-scope-1');
    for (const d of receipt.diagnostics) say(`      diagnostic ${d.code}: ${d.message}`);
    expect(
      receipt.diagnostics.some((d) => d.code === 'scope_violation'),
      'receipt.get explains the violation',
    );
    expect(
      JSON.stringify((await client.inspect()).project) === JSON.stringify(before.project),
      'nothing was changed',
    );
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`\ndemo FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
