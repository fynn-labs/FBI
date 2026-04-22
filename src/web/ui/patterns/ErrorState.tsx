export interface ErrorStateProps { message: string; }

export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div role="alert" className="p-3 border border-fail/40 bg-fail-subtle text-fail rounded-md text-[14px] font-mono">
      {message}
    </div>
  );
}
