import { useEffect, useState } from 'react';
import type { Run } from '@shared/types.js';
import { Dialog } from '@ui/primitives/Dialog.js';
import { ModelParamsCollapse, type ModelParamsValue } from './ModelParamsCollapse.js';

export function ContinueRunDialog(props: {
  run: Run;
  open: boolean;
  onClose: () => void;
  onSubmit: (params: ModelParamsValue) => Promise<void> | void;
}): JSX.Element | null {
  const { run, open, onClose, onSubmit } = props;
  const [value, setValue] = useState<ModelParamsValue>({
    model: run.model,
    effort: run.effort,
    subagent_model: run.subagent_model,
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setValue({
        model: run.model,
        effort: run.effort,
        subagent_model: run.subagent_model,
      });
    }
  }, [open, run.id, run.model, run.effort, run.subagent_model]);

  async function handleSubmit(): Promise<void> {
    setSubmitting(true);
    try {
      await onSubmit(value);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Continue run"
    >
      <div data-testid="continue-dialog" className="space-y-4">
        <p className="text-sm text-text-dim">
          Model params are pre-filled from this run. Change any to override on resume.
        </p>
        <ModelParamsCollapse value={value} onChange={setValue} />
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            className="px-3 py-1 rounded border border-border"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-3 py-1 rounded bg-accent text-accent-foreground disabled:opacity-50"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Continuing…' : 'Continue'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
