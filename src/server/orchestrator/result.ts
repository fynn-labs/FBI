export type ResultClassification =
  | { kind: 'completed'; exit_code: number; push_exit: number; head_sha: string; branch: string }
  | { kind: 'resume_failed'; error: string; parent_sha?: string; snapshot_sha?: string; origin_tip?: string }
  | { kind: 'unparseable'; raw: string };

export function classifyResultJson(raw: string): ResultClassification {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j.stage === 'restore' && typeof j.error === 'string') {
      return {
        kind: 'resume_failed',
        error: j.error,
        parent_sha: j.parent_sha as string | undefined,
        snapshot_sha: j.snapshot_sha as string | undefined,
        origin_tip: j.origin_tip as string | undefined,
      };
    }
    if (typeof j.exit_code === 'number') {
      return {
        kind: 'completed',
        exit_code: j.exit_code as number,
        push_exit: (j.push_exit as number) ?? 0,
        head_sha: (j.head_sha as string) ?? '',
        branch: (j.branch as string) ?? '',
      };
    }
    return { kind: 'unparseable', raw };
  } catch {
    return { kind: 'unparseable', raw };
  }
}

export interface ContainerResult {
  exit_code: number;
  push_exit: number;
  head_sha: string;
  branch?: string;
  title?: string;
}

export function parseResultJson(text: string): ContainerResult | null {
  try {
    const obj = JSON.parse(text.trim());
    if (
      typeof obj.exit_code === 'number' &&
      typeof obj.push_exit === 'number' &&
      typeof obj.head_sha === 'string'
    ) {
      const result: ContainerResult = {
        exit_code: obj.exit_code,
        push_exit: obj.push_exit,
        head_sha: obj.head_sha,
      };
      if (typeof obj.branch === 'string' && obj.branch.length > 0) {
        result.branch = obj.branch;
      }
      if (typeof obj.title === 'string') {
        const t = obj.title.trim().slice(0, 80);
        if (t.length > 0) result.title = t;
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
}
