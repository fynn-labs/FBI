import { Input } from '@ui/primitives/Input.js';

export interface RunsFilterProps {
  value: string;
  onChange: (v: string) => void;
}

export function RunsFilter({ value, onChange }: RunsFilterProps) {
  return (
    <div className="p-2 border-b border-border bg-surface">
      <Input
        className="w-full"
        placeholder="Filter by prompt / branch / id…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
