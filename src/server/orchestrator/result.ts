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
