import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { RecentPromptsDropdown } from '../components/RecentPromptsDropdown.js';
import { UploadTray, type UploadTrayFile } from '../components/UploadTray.js';
import { FormRow } from '@ui/patterns/FormRow.js';
import { Input, Textarea, Button } from '@ui/primitives/index.js';
import { ErrorState } from '@ui/patterns/ErrorState.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';
import { UsageWarning } from '../features/usage/UsageWarning.js';

const PER_FILE = 100 * 1024 * 1024;
const PER_RUN = 1024 * 1024 * 1024;

export function NewRunPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [branch, setBranch] = useState(searchParams.get('branch') ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftToken, setDraftToken] = useState<string | null>(null);
  const [attached, setAttached] = useState<UploadTrayFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function insertAtCursor(el: HTMLTextAreaElement | null, text: string): void {
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${lead}${text}${after}`;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    setter?.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const pos = start + lead.length + text.length;
    el.setSelectionRange(pos, pos);
    el.focus();
  }

  function stripExactToken(el: HTMLTextAreaElement | null, token: string): void {
    if (!el) return;
    const idx = el.value.indexOf(token);
    if (idx < 0) return;
    const next = el.value.slice(0, idx) + el.value.slice(idx + token.length);
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    setter?.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    try {
      const run = await api.createRun(pid, prompt, branch || undefined, draftToken ?? undefined);
      nav(`/projects/${pid}/runs/${run.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const submitRef = useRef(submit);
  submitRef.current = submit;
  useKeyBinding({ chord: 'mod+enter', handler: () => void submitRef.current(), description: 'Submit run' }, []);

  if (!Number.isFinite(pid)) return <ErrorState message="Invalid project ID." />;

  return (
    <form onSubmit={submit} className="max-w-3xl mx-auto p-6 space-y-4">
      <UsageWarning />
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">New run</h1>
      <RecentPromptsDropdown projectId={pid} onPick={setPrompt} />
      <FormRow label="Branch name" hint="Leave blank to let Claude choose.">
        <Input className="w-full" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/branch-name" />
      </FormRow>
      <FormRow label="Prompt">
        <Textarea
          ref={textareaRef}
          className="w-full" rows={12} autoFocus
          value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what Claude should do…"
        />
        <UploadTray
          attached={attached}
          upload={async (file) => {
            const res = await api.uploadDraftFile(file, draftToken);
            setDraftToken(res.draft_token);
            setAttached(prev => [...prev, { filename: res.filename, size: res.size }]);
            return { filename: res.filename, size: res.size };
          }}
          onUploaded={(filename) => {
            insertAtCursor(textareaRef.current, `@/fbi/uploads/${filename} `);
          }}
          onRemove={async (filename) => {
            if (!draftToken) return;
            try {
              await api.deleteDraftFile(draftToken, filename);
            } catch { /* best-effort delete */ }
            setAttached(prev => prev.filter(f => f.filename !== filename));
            stripExactToken(textareaRef.current, `@/fbi/uploads/${filename} `);
          }}
          maxFileBytes={PER_FILE}
          maxTotalBytes={PER_RUN}
          totalBytes={attached.reduce((n, f) => n + f.size, 0)}
        />
      </FormRow>
      {error && <ErrorState message={error} />}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting}>{submitting ? 'Starting…' : 'Start run'}</Button>
        <span className="text-[13px] text-text-faint">⌘⏎ to submit</span>
      </div>
    </form>
  );
}
