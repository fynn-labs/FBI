import { useState } from 'react';

export interface ModelParamsValue {
  model: string | null;
  effort: string | null;
  subagent_model: string | null;
}

const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
  { value: 'haiku', label: 'haiku' },
] as const;

const SUBAGENT_OPTIONS = [
  { value: '', label: 'Inherit' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'opus', label: 'opus' },
  { value: 'haiku', label: 'haiku' },
] as const;

function effortOptionsFor(model: string | null): string[] {
  if (model === 'haiku') return [];
  if (model === 'opus') return ['low', 'medium', 'high', 'xhigh', 'max'];
  return ['low', 'medium', 'high', 'max']; // sonnet or default/unset
}

function effortStillValid(model: string | null, effort: string | null): boolean {
  if (effort === null) return true;
  const allowed = effortOptionsFor(model);
  return allowed.includes(effort);
}

export function ModelParamsCollapse(props: {
  value: ModelParamsValue;
  onChange: (v: ModelParamsValue) => void;
}): JSX.Element {
  const { value, onChange } = props;
  const [expanded, setExpanded] = useState(false);

  const summary =
    `${value.model ?? 'default'} · effort: ${value.effort ?? 'default'} · ` +
    `subagent: ${value.subagent_model ?? 'inherit'}`;

  const effortDisabled = value.model === 'haiku';
  const effortChoices = effortOptionsFor(value.model);

  function setModel(next: string | null): void {
    const effort = effortStillValid(next, value.effort) ? value.effort : null;
    onChange({ model: next, effort, subagent_model: value.subagent_model });
  }
  function setEffort(next: string | null): void {
    onChange({ model: value.model, effort: next, subagent_model: value.subagent_model });
  }
  function setSubagent(next: string | null): void {
    onChange({ model: value.model, effort: value.effort, subagent_model: next });
  }

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        type="button"
        data-testid="modelparams-toggle"
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-surface-hover"
      >
        <span className="inline-block w-3">{expanded ? '▾' : '▸'}</span>
        <span className="font-medium">Model & effort</span>
        <span
          data-testid="modelparams-summary"
          className="text-text-dim text-sm"
        >
          · {summary}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-3 bg-surface-subtle">
          <label className="flex items-center gap-3">
            <span className="w-32 text-sm text-text-dim">Model</span>
            <select
              data-testid="modelparams-model-select"
              value={value.model ?? ''}
              onChange={(e) => setModel(e.target.value === '' ? null : e.target.value)}
              className="border border-border rounded px-2 py-1"
            >
              {MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-3">
            <span className="w-32 text-sm text-text-dim">Effort</span>
            <select
              data-testid="modelparams-effort-select"
              value={value.effort ?? ''}
              disabled={effortDisabled}
              onChange={(e) => setEffort(e.target.value === '' ? null : e.target.value)}
              className="border border-border rounded px-2 py-1"
            >
              <option value="">Default</option>
              {effortChoices.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            {effortDisabled && (
              <span className="text-xs text-text-dim">Not supported on Haiku</span>
            )}
          </label>
          <label className="flex items-center gap-3">
            <span className="w-32 text-sm text-text-dim">Subagent model</span>
            <select
              data-testid="modelparams-subagent-select"
              value={value.subagent_model ?? ''}
              onChange={(e) => setSubagent(e.target.value === '' ? null : e.target.value)}
              className="border border-border rounded px-2 py-1"
            >
              {SUBAGENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
