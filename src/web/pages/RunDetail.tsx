import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Project, Run, FilesPayload, GithubPayload } from '@shared/types.js';
import { api } from '../lib/api.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';
import { ErrorState } from '@ui/patterns/index.js';
import { RunHeader } from '../features/runs/RunHeader.js';
import { RunTerminal } from '../features/runs/RunTerminal.js';
import { RunDrawer } from '../features/runs/RunDrawer.js';
import { FilesTab } from '../features/runs/FilesTab.js';
import { GithubTab } from '../features/runs/GithubTab.js';
import { MetaTab } from '../features/runs/MetaTab.js';
import { TunnelTab } from '../features/runs/TunnelTab.js';
import { useBottomPaneHeight } from '../features/runs/useBottomPaneHeight.js';
import type { ListeningPort } from '@shared/types.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';
import { subscribeState, subscribeTitle, subscribeFiles } from '../features/runs/usageBus.js';
import { UploadTray, type UploadTrayFile } from '../components/UploadTray.js';
import { ContinueRunDialog } from '../components/ContinueRunDialog.js';
import { acquireShell, releaseShell } from '../lib/shellRegistry.js';

export function RunDetailPage() {
  const params = useParams();
  const runId = Number(params.rid ?? params.id);
  const urlPid = params.id && params.rid ? Number(params.id) : null;
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [gh, setGh] = useState<GithubPayload | null>(null);
  const [siblings, setSiblings] = useState<Run[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [creatingPr, setCreatingPr] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [files, setFiles] = useState<FilesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [attached, setAttached] = useState<UploadTrayFile[]>([]);
  const [continueOpen, setContinueOpen] = useState(false);
  const terminalPaneRef = useRef<HTMLDivElement | null>(null);
  const { height, setHeight } = useBottomPaneHeight();

  const refreshUploads = useCallback(async () => {
    try {
      const { files } = await api.listRunUploads(runId);
      setAttached(files.map(f => ({ filename: f.filename, size: f.size })));
    } catch { /* silent */ }
  }, [runId]);

  useEffect(() => {
    void refreshUploads();
  }, [refreshUploads]);

  useEffect(() => {
    if (run?.state === 'waiting') void refreshUploads();
  }, [run?.state, refreshUploads]);

  useKeyBinding({ chord: 'mod+j', handler: () => setDrawerOpen((v) => !v), description: 'Toggle run drawer' }, []);

  useEffect(() => {
    let alive = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const load = async () => {
      try {
        const r = await api.getRun(runId);
        if (alive) setRun(r);
      } catch (err) {
        const msg = String(err);
        if (msg.includes('HTTP 404') || msg.includes(' 404 ')) {
          if (alive) {
            setError(`Run #${runId} not found`);
            if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
          }
        }
      }
    };
    void load();
    intervalId = setInterval(load, 3000);
    return () => { alive = false; if (intervalId !== null) clearInterval(intervalId); };
  }, [runId]);

  useEffect(() => {
    if (!run) return;
    void api.getRunSiblings(run.id).then(setSiblings).catch(() => setSiblings([]));
    void api.getProject(run.project_id).then(setProject).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  useEffect(() => {
    if (!run) return;
    if (urlPid == null) return;
    if (run.project_id === urlPid) return;
    nav(`/projects/${run.project_id}/runs/${run.id}`, { replace: true });
  }, [run?.id, run?.project_id, urlPid, nav]);

  useEffect(() => {
    return subscribeState((id, frame) => {
      if (id !== runId) return;
      setRun((r) => r ? {
        ...r,
        state: frame.state,
        state_entered_at: frame.state_entered_at,
        next_resume_at: frame.next_resume_at,
        resume_attempts: frame.resume_attempts,
        last_limit_reset_at: frame.last_limit_reset_at,
      } : r);
    });
  }, [runId]);

  useEffect(() => {
    return subscribeTitle((id, frame) => {
      setRun((r) => r && r.id === id ? { ...r, title: frame.title, title_locked: frame.title_locked } : r);
    });
  }, []);

  useEffect(() => {
    return subscribeFiles((id, payload) => {
      if (id !== runId) return;
      setFiles(payload);
    });
  }, [runId]);

  // GitHub tab: poll every 10s regardless of run state, so commits/PR/CI stay
  // current both during and after the run.
  useEffect(() => {
    if (!run) return;
    let alive = true;
    const load = async () => {
      try { const g = await api.getRunGithub(run.id); if (alive) setGh(g); } catch { /* ignore */ }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  // Files: initial one-shot fetch. Live updates come via the `files` WS event;
  // the initial fetch covers finished runs and gives us a fallback snapshot
  // before the first WS event arrives.
  useEffect(() => {
    if (!run) return;
    let alive = true;
    void api.getRunFiles(run.id).then((f) => { if (alive) setFiles(f); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  useEffect(() => {
    if (!run) return;
    const containerLive = run.state === 'running' || run.state === 'waiting';
    if (!containerLive) {
      setPorts([]);
      return;
    }
    let alive = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const { ports: p } = await api.getRunListeningPorts(run.id);
        if (alive) setPorts(p);
      } catch { /* transient errors retained the last-known list */ }
    };
    const start = () => {
      if (interval != null) return;
      void tick();
      interval = setInterval(tick, 2000);
    };
    const stop = () => {
      if (interval != null) { clearInterval(interval); interval = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    document.addEventListener('visibilitychange', onVis);
    if (document.visibilityState === 'visible') start();
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.state]);

  if (error) return <ErrorState message={error} />;
  if (!run) return <LoadingState label="Loading run…" />;
  const interactive = run.state === 'running' || run.state === 'queued' || run.state === 'waiting';

  async function cancel() {
    if (!confirm('Cancel this run?')) return;
    try { await api.deleteRun(runId); } catch { /* ignore */ }
  }
  async function remove() {
    if (!confirm('Delete this run and its transcript?')) return;
    try { await api.deleteRun(runId); nav(-1); } catch { /* ignore */ }
  }

  function openContinueDialog(): void {
    if (!run) return;
    setContinueOpen(true);
  }

  async function onContinueConfirm(params: {
    model: string | null;
    effort: string | null;
    subagent_model: string | null;
  }): Promise<void> {
    if (!run) return;
    try {
      await api.continueRun(run.id, params);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const m = raw.match(/^HTTP \d+:\s*(.+)$/);
      let shown = raw;
      if (m) {
        try {
          const parsed = JSON.parse(m[1]) as { message?: string };
          if (parsed.message) shown = parsed.message;
        } catch { /* leave raw */ }
      }
      alert(shown);
    }
  }

  async function createPr() {
    if (!run) return;
    setCreatingPr(true);
    try { await api.createRunPr(run.id); const g = await api.getRunGithub(run.id); setGh(g); }
    catch (e) { alert(String(e)); }
    finally { setCreatingPr(false); }
  }

  async function onMerged() {
    if (!run) return;
    try { const g = await api.getRunGithub(run.id); setGh(g); } catch { /* ignore */ }
  }

  const fileCount = (files?.dirty.length ?? 0)
    + (files?.headFiles.filter((h) => !files?.dirty.some((d) => d.path === h.path)).length ?? 0);

  return (
    <div className="h-full flex flex-col min-h-0">
      <RunHeader run={run} onCancel={cancel} onDelete={remove} onContinue={openContinueDialog} onRenamed={setRun} />
      <div className="flex-1 min-h-0 flex flex-col">
        <div
          ref={terminalPaneRef}
          className="flex-1 min-h-0 relative flex flex-col overflow-hidden data-[upload-drag-active=true]:ring-2 data-[upload-drag-active=true]:ring-accent data-[upload-drag-active=true]:ring-inset transition-[box-shadow] duration-fast ease-out"
        >
          <RunTerminal runId={run.id} interactive={interactive} />
        </div>
        <div className="px-3 py-2 border-t border-border">
          <UploadTray
            disabled={run.state !== 'waiting' && run.state !== 'running'}
            disabledReason="Uploads are available while the run is active."
            dropZoneRef={terminalPaneRef}
            attached={attached}
            upload={async (file) => {
              const res = await api.uploadRunFile(run.id, file);
              setAttached(prev => [...prev, { filename: res.filename, size: res.size }]);
              return { filename: res.filename, size: res.size };
            }}
            onUploaded={(filename) => {
              const text = `@/fbi/uploads/${filename} `;
              const shell = acquireShell(run.id);
              shell.send(new TextEncoder().encode(text));
              releaseShell(run.id);
            }}
            onRemove={async (filename) => {
              try {
                await api.deleteRunUpload(run.id, filename);
              } catch { /* best-effort */ }
              setAttached(prev => prev.filter(f => f.filename !== filename));
            }}
            maxFileBytes={100 * 1024 * 1024}
            maxTotalBytes={1024 * 1024 * 1024}
            totalBytes={attached.reduce((n, f) => n + f.size, 0)}
          />
        </div>
        <RunDrawer
          open={drawerOpen}
          onToggle={setDrawerOpen}
          filesCount={fileCount}
          portsCount={run.state === 'running' || run.state === 'waiting' ? ports.length : null}
          height={height}
          onHeightChange={setHeight}
        >
          {(t) => t === 'files' ? <FilesTab runId={run.id} files={files} project={project} branchName={run.branch_name || null} runState={run.state} />
               : t === 'github' ? <GithubTab run={run} github={gh} onCreatePr={createPr} onMerged={onMerged} creatingPr={creatingPr} />
               : t === 'tunnel' ? <TunnelTab runId={run.id} runState={run.state} origin={window.location.origin} ports={ports} />
               : <MetaTab run={run} siblings={siblings} />}
        </RunDrawer>
      </div>
      {run && (
        <ContinueRunDialog
          run={run}
          open={continueOpen}
          onClose={() => setContinueOpen(false)}
          onSubmit={onContinueConfirm}
        />
      )}
    </div>
  );
}
