import { useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { RecentPromptsDropdown } from '../components/RecentPromptsDropdown.js';
import { FormRow } from '@ui/patterns/FormRow.js';
import { Input, Textarea, Button } from '@ui/primitives/index.js';
import { ErrorState } from '@ui/patterns/ErrorState.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';
import { UsageWarning } from '../features/usage/UsageWarning.js';

export function NewRunPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [branch, setBranch] = useState(searchParams.get('branch') ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    try {
      const run = await api.createRun(pid, prompt, branch || undefined);
      nav(`/projects/${pid}/runs/${run.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  useKeyBinding({ chord: 'mod+enter', handler: () => void submit(), description: 'Submit run' }, []);

  if (!Number.isFinite(pid)) return <ErrorState message="Invalid project ID." />;

  return (
    <form onSubmit={submit} className="max-w-3xl mx-auto p-6 space-y-4">
      <UsageWarning />
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]">New run</h1>
      <RecentPromptsDropdown projectId={pid} onPick={setPrompt} />
      <FormRow label="Branch name" hint="Leave blank to let Claude choose.">
        <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/branch-name" />
      </FormRow>
      <FormRow label="Prompt">
        <Textarea rows={12} autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what Claude should do…" />
      </FormRow>
      {error && <ErrorState message={error} />}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting}>{submitting ? 'Starting…' : 'Start run'}</Button>
        <span className="text-[12px] text-text-faint">⌘⏎ to submit</span>
      </div>
    </form>
  );
}
