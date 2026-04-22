import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';
import { ErrorState } from '@ui/patterns/index.js';
import { RunHeader } from '../features/runs/RunHeader.js';
import { RunTerminal } from '../features/runs/RunTerminal.js';
import { RunSidePanel } from '../features/runs/RunSidePanel.js';
import { RunDrawer } from '../features/runs/RunDrawer.js';
import { FilesTab } from '../features/runs/FilesTab.js';
import { PromptTab } from '../features/runs/PromptTab.js';
import { GithubTab } from '../features/runs/GithubTab.js';
import { TunnelTab } from '../features/runs/TunnelTab.js';
import type { ListeningPort } from '@shared/types.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';
import { subscribeState } from '../features/runs/usageBus.js';

export function RunDetailPage() {
  const params = useParams();
  const runId = Number(params.rid ?? params.id);
  const urlPid = params.id && params.rid ? Number(params.id) : null;
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [gh, setGh] = useState<Awaited<ReturnType<typeof api.getRunGithub>> | null>(null);
  const [siblings, setSiblings] = useState<Run[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [creatingPr, setCreatingPr] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof api.getRunDiff>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ports, setPorts] = useState<ListeningPort[]>([]);

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
        // transient errors: keep polling
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

  // If the URL says this run belongs to project X but the server says it
  // belongs to project Y, bounce to the canonical URL so the header and
  // run list match the run being shown.
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
        next_resume_at: frame.next_resume_at,
        resume_attempts: frame.resume_attempts,
        last_limit_reset_at: frame.last_limit_reset_at,
      } : r);
    });
  }, [runId]);

  useEffect(() => {
    if (!run || run.state !== 'succeeded') return;
    let alive = true;
    const load = async () => {
      try { const g = await api.getRunGithub(run.id); if (alive) setGh(g); } catch { /* ignore */ }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.state]);

  useEffect(() => {
    if (!run || run.state !== 'succeeded') return;
    let alive = true;
    void api.getRunDiff(run.id).then((d) => { if (alive) setDiff(d); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.state]);

  useEffect(() => {
    if (!run) return;
    if (run.state !== 'running') {
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
  const interactive = run.state === 'running' || run.state === 'queued';

  async function cancel() {
    if (!confirm('Cancel this run?')) return;
    try { await api.deleteRun(runId); } catch { /* ignore */ }
  }
  async function remove() {
    if (!confirm('Delete this run and its transcript?')) return;
    try { await api.deleteRun(runId); nav(-1); } catch { /* ignore */ }
  }

  async function kontinue() {
    if (!run) return;
    try { await api.continueRun(run.id); }
    catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // The server returns { code, message } on 409 and { message } on 500.
      // `request()` surfaces the body as a trailing JSON-ish string on the
      // error — unwrap it so the alert shows only the human message.
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

  return (
    <div className="h-full flex flex-col min-h-0">
      <RunHeader run={run} onCancel={cancel} onDelete={remove} onContinue={kontinue} />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <RunTerminal runId={run.id} interactive={interactive} />
          <RunDrawer
            open={drawerOpen}
            onToggle={setDrawerOpen}
            filesCount={diff?.files.length ?? 0}
            portsCount={run.state === 'running' ? ports.length : null}
          >
            {(t) => t === 'files' ? <FilesTab diff={diff} project={project} runState={run.state} />
                 : t === 'prompt' ? <PromptTab prompt={run.prompt} />
                 : t === 'github' ? <GithubTab github={gh} runState={run.state} />
                 : <TunnelTab runId={run.id} runState={run.state} origin={window.location.origin} ports={ports} />}
          </RunDrawer>
        </div>
        <RunSidePanel run={run} siblings={siblings} github={gh} onCreatePr={createPr} creatingPr={creatingPr} />
      </div>
    </div>
  );
}
