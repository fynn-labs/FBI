export function PromptTab({ prompt }: { prompt: string }) {
  return <pre className="p-3 font-mono text-[11px] whitespace-pre-wrap text-text-dim">{prompt}</pre>;
}
