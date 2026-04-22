export function PromptTab({ prompt }: { prompt: string }) {
  return <pre className="p-3 font-mono text-[13px] whitespace-pre-wrap text-text-dim">{prompt}</pre>;
}
