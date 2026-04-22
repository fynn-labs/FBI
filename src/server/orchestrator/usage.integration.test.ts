import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { UsageRepo } from '../db/usage.js';
import { UsageTailer } from './usageTailer.js';
import { OAuthUsagePoller } from '../oauthUsagePoller.js';
import { RateLimitStateRepo } from '../db/rateLimitState.js';
import { RateLimitBucketsRepo } from '../db/rateLimitBuckets.js';

async function dockerAvailable(): Promise<boolean> {
  try { await new Docker().ping(); return true; }
  catch { return false; }
}

describe('usage integration (Docker-gated)', () => {
  it('captures a JSONL written into the bind-mounted directory', async () => {
    if (!(await dockerAvailable())) return;  // auto-skip
    const docker = new Docker();

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-int-'));
    const claudeProjectsDir = path.join(hostDir, 'claude-projects');
    fs.mkdirSync(claudeProjectsDir, { recursive: true, mode: 0o777 });

    const db = openDb(path.join(hostDir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const usage = new UsageRepo(db);
    const p = projects.create({
      name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null,
    });
    const run = runs.create({
      project_id: p.id, prompt: 'hi',
      log_path_tmpl: (id) => path.join(hostDir, `${id}.log`),
    });

    // Tailer watches the host-side dir.
    const tailer = new UsageTailer({
      dir: claudeProjectsDir, pollMs: 200,
      onUsage: (snapshot) => usage.insertUsageEvent({
        run_id: run.id, ts: Date.now(), snapshot, rate_limit: null,
      }),
      onRateLimit: () => {}, onError: () => {},
    });
    tailer.start();

    // Container writes a JSONL line into /home/agent/.claude/projects/-workspace/sess.jsonl.
    const canned = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) + '\n';

    const container = await docker.createContainer({
      Image: 'alpine:3',
      Cmd: ['sh', '-c',
        `mkdir -p /home/agent/.claude/projects/-workspace && ` +
        `printf '%s' '${canned.replace(/'/g, "'\\''")}' > /home/agent/.claude/projects/-workspace/sess.jsonl`,
      ],
      HostConfig: {
        AutoRemove: false,
        Binds: [`${claudeProjectsDir}:/home/agent/.claude/projects`],
      },
    });
    await container.start();
    await container.wait();
    await container.remove({ force: true, v: true }).catch(() => {});

    // Let the tailer see it, then stop (final pass).
    await new Promise((r) => setTimeout(r, 400));
    await tailer.stop();

    const after = runs.get(run.id)!;
    expect(after.tokens_input).toBe(123);
    expect(after.tokens_output).toBe(45);
    expect(after.tokens_total).toBe(168);
  }, 30_000);
});

// --- OAuth poller integration (no Docker) ---
describe('OAuthUsagePoller integration: happy → 429', () => {
  it('transitions last_error across polls', async () => {
    const db = openDb(':memory:');
    const state = new RateLimitStateRepo(db);
    const buckets = new RateLimitBucketsRepo(db);

    let step = 0;
    const fetchFn = (async (url: string) => {
      if (String(url).endsWith('/profile')) {
        return new Response(JSON.stringify({ plan: 'max' }), { status: 200 });
      }
      step++;
      if (step === 1) {
        const now = Date.now();
        return new Response(
          JSON.stringify({ buckets: [{ id: 'five_hour', utilization: 10, resets_at: now + 3600_000 }] }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 429 });
    }) as unknown as typeof fetch;

    const lastErrors: Array<string | null> = [];
    const poller = new OAuthUsagePoller({
      fetch: fetchFn,
      readToken: () => 'tok',
      state, buckets,
      onEvent: (e) => {
        if (e.type === 'snapshot') lastErrors.push(e.state.last_error);
      },
    });
    await poller.pollOnce();
    await poller.pollOnce();
    expect(lastErrors).toContain(null);
    expect(lastErrors).toContain('rate_limited');
    expect(buckets.list()).toHaveLength(1); // preserved across 429
  });
});
