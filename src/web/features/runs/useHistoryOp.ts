import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import type { HistoryOp, HistoryResult } from '@shared/types.js';

export function useHistoryOp(runId: number, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const nav = useNavigate();

  const run = useCallback(async (op: HistoryOp): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const r: HistoryResult = await api.postRunHistory(runId, op);
      if (r.kind === 'complete') {
        setMsg(r.sha ? `Done (${r.sha.slice(0, 7)})` : 'Done');
        onDone?.();
      } else if (r.kind === 'agent' || r.kind === 'conflict') {
        const label = r.kind === 'conflict' ? 'Conflict — delegated' : 'Delegated to agent';
        setMsg(`${label} (run #${r.child_run_id}) — click to view`);
        setTimeout(() => nav(`/runs/${r.child_run_id}`), 1200);
      } else if (r.kind === 'agent-busy') {
        setMsg('Agent not available — try again when the run is live.');
      } else if (r.kind === 'invalid') {
        setMsg(`Invalid: ${r.message}`);
      } else if (r.kind === 'git-error') {
        setMsg(`Git: ${r.message}`);
      } else if (r.kind === 'git-unavailable') {
        setMsg('Git operation failed.');
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }, [runId, onDone, nav]);

  return { busy, msg, run };
}
