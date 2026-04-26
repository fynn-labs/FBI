import { expect, type Page } from '@playwright/test';

export type ScenarioName =
  | 'default' | 'chatty' | 'limit-breach' | 'limit-breach-human'
  | 'crash-fast' | 'hang' | 'garbled' | 'slow-startup'
  | 'env-echo' | 'resume-aware' | 'tool-heavy' | 'plugin-fail';

export interface RunHandle {
  id: number;
  page: Page;
  waitForTerminalText(needle: string, opts?: { timeoutMs?: number }): Promise<void>;
  terminalText(): Promise<string>;
  expectScrolledToBottom(): Promise<void>;
  destroy(): Promise<void>;
}

/** Creates a project (idempotent) then navigates to /projects/:id/runs/new and submits a mock run. */
export async function createMockRun(
  page: Page,
  opts: { scenario: ScenarioName; prompt?: string },
): Promise<RunHandle> {
  const projectId = await ensureProject(page);
  await page.goto(`/projects/${projectId}/runs/new`);

  await page.getByPlaceholder(/Describe what Claude should do/i)
    .fill(opts.prompt ?? `quantico ${opts.scenario}`);
  await page.getByTestId('mockmode-toggle').click();
  await page.getByTestId('mockmode-enable').check();
  await page.getByTestId('mockmode-scenario-select').selectOption(opts.scenario);

  await page.getByRole('button', { name: /Start run/i }).click();
  await page.waitForURL(/\/projects\/\d+\/runs\/\d+/);
  const url = page.url();
  const id = Number(url.match(/runs\/(\d+)/)![1]);
  return wrap(id, page);
}

async function ensureProject(page: Page): Promise<number> {
  const res = await page.request.get('/api/projects');
  const list = await res.json() as Array<{ id: number }>;
  if (list.length > 0) return list[0].id;
  const created = await page.request.post('/api/projects', {
    data: { name: 'e2e', repo_url: '/tmp/empty-repo.git', default_branch: 'main' },
  });
  return ((await created.json()) as { id: number }).id;
}

function wrap(id: number, page: Page): RunHandle {
  return {
    id, page,
    async waitForTerminalText(needle, opts) {
      await expect(page.getByTestId('xterm')).toContainText(needle, { timeout: opts?.timeoutMs ?? 30_000 });
    },
    async terminalText() {
      return (await page.getByTestId('xterm').textContent()) ?? '';
    },
    async expectScrolledToBottom() {
      const atBottom = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement | null;
        if (!el) return false;
        return Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 4;
      });
      expect(atBottom).toBe(true);
    },
    async destroy() {
      await page.request.delete(`/api/runs/${id}`).catch(() => {});
    },
  };
}
