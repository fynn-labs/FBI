import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';
import { RunHeader } from '../features/runs/RunHeader.js';
import { RunTerminal } from '../features/runs/RunTerminal.js';
import { RunSidePanel } from '../features/runs/RunSidePanel.js';
import { RunDrawer } from '../features/runs/RunDrawer.js';
import { FilesTab } from '../features/runs/FilesTab.js';
import { PromptTab } from '../features/runs/PromptTab.js';
import { GithubTab } from '../features/runs/GithubTab.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';

export function RunDetailPage() {
  const params = useParams();
  const runId = Number(params.rid ?? params.id);
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [gh, setGh] = useState<Awaited<ReturnType<typeof api.getRunGithub>> | null>(null);
  const [siblings, setSiblings] = useState<Run[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [creatingPr, setCreatingPr] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof api.getRunDiff>> | null>(null);

  useKeyBinding({ chord: 'mod+j', handler: () => setDrawerOpen((v) => !v), description: 'Toggle run drawer' }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.getRun(runId);
        if (alive) setRun(r);
      } catch { /* ignore */ }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [runId]);

  useEffect(() => {
    if (!run) return;
    void api.getRunSiblings(run.id).then(setSiblings).catch(() => setSiblings([]));
    void api.getProject(run.project_id).then(setProject).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

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

  async function createPr() {
    if (!run) return;
    setCreatingPr(true);
    try { await api.createRunPr(run.id); const g = await api.getRunGithub(run.id); setGh(g); }
    catch (e) { alert(String(e)); }
    finally { setCreatingPr(false); }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <RunHeader run={run} onCancel={cancel} onDelete={remove} />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <RunTerminal runId={run.id} interactive={interactive} />
          <RunDrawer
            open={drawerOpen}
            onToggle={setDrawerOpen}
            filesCount={diff?.files.length ?? 0}
          >
            {(t) => t === 'files' ? <FilesTab diff={diff} project={project} />
                 : t === 'prompt' ? <PromptTab prompt={run.prompt} />
                 : <GithubTab github={gh} />}
          </RunDrawer>
        </div>
        <RunSidePanel run={run} siblings={siblings} github={gh} onCreatePr={createPr} creatingPr={creatingPr} />
      </div>
    </div>
  );
}
