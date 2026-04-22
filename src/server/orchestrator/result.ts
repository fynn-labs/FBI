export interface ContainerResult {
  exit_code: number;
  push_exit: number;
  head_sha: string;
}

export function parseResultJson(text: string): ContainerResult | null {
  try {
    const obj = JSON.parse(text.trim());
    if (
      typeof obj.exit_code === 'number' &&
      typeof obj.push_exit === 'number' &&
      typeof obj.head_sha === 'string'
    ) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}
