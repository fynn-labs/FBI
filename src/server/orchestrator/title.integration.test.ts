import { describe, it, expect } from 'vitest';
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { TitleWatcher } from './titleWatcher.js';

async function dockerAvailable(): Promise<boolean> {
  try { await new Docker().ping(); return true; } catch { return false; }
}

describe('title integration (Docker-gated)', () => {
  it('captures a session-name written from a container', async () => {
    if (!(await dockerAvailable())) return;
    const docker = new Docker();
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-title-int-'));
    const stateDir = path.join(hostDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o777 });

    const db = openDb(path.join(hostDir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null });
    const run = runs.create({ project_id: p.id, prompt: 'hi',
      log_path_tmpl: (id) => path.join(hostDir, `${id}.log`) });

    const watcher = new TitleWatcher({
      path: path.join(stateDir, 'session-name'), pollMs: 100,
      onTitle: (t) => runs.updateTitle(run.id, t, { respectLock: true }),
      onError: () => {},
    });
    watcher.start();

    const container = await docker.createContainer({
      Image: 'alpine:3',
      Cmd: ['sh', '-c', `printf 'Fix auth race' > /fbi-state/session-name`],
      HostConfig: { AutoRemove: false, Binds: [`${stateDir}:/fbi-state/`] },
    });
    await container.start();
    await container.wait();
    await container.remove({ force: true, v: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await watcher.stop();

    expect((runs.get(run.id) as any).title).toBe('Fix auth race');
    expect((runs.get(run.id) as any).title_locked).toBe(0);
  }, 30_000);

  it('user-locked title is not overwritten', async () => {
    if (!(await dockerAvailable())) return;
    const docker = new Docker();
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-title-int-lock-'));
    const stateDir = path.join(hostDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o777 });

    const db = openDb(path.join(hostDir, 'db.sqlite'));
    const projects = new ProjectsRepo(db);
    const runs = new RunsRepo(db);
    const p = projects.create({ name: 'p', repo_url: 'r', default_branch: 'main',
      devcontainer_override_json: null, instructions: null,
      git_author_name: null, git_author_email: null });
    const run = runs.create({ project_id: p.id, prompt: 'hi',
      log_path_tmpl: (id) => path.join(hostDir, `${id}.log`) });
    runs.updateTitle(run.id, 'User pick', { lock: true, respectLock: false });

    const watcher = new TitleWatcher({
      path: path.join(stateDir, 'session-name'), pollMs: 100,
      onTitle: (t) => runs.updateTitle(run.id, t, { respectLock: true }),
      onError: () => {},
    });
    watcher.start();

    const container = await docker.createContainer({
      Image: 'alpine:3',
      Cmd: ['sh', '-c', `printf 'Claude draft' > /fbi-state/session-name`],
      HostConfig: { AutoRemove: false, Binds: [`${stateDir}:/fbi-state/`] },
    });
    await container.start();
    await container.wait();
    await container.remove({ force: true, v: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await watcher.stop();

    expect((runs.get(run.id) as any).title).toBe('User pick');
    expect((runs.get(run.id) as any).title_locked).toBe(1);
  }, 30_000);
});
