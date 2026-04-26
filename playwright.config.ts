import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e/quantico',
  timeout: 120_000,
  fullyParallel: false, // shared FBI server
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'PORT=3100 FBI_QUANTICO_ENABLED=1 MOCK_CLAUDE_SPEED_MULT=10 FBI_LIMIT_MONITOR_IDLE_MS=300 FBI_LIMIT_MONITOR_WARMUP_MS=200 npm run dev:server',
    url: 'http://127.0.0.1:3100/api/quantico/scenarios',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      DB_PATH: '/tmp/fbi-e2e.db',
      RUNS_DIR: '/tmp/fbi-e2e-runs',
      SECRETS_KEY_FILE: '/tmp/fbi-e2e.key',
      GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
      FBI_QUANTICO_BINARY_PATH: process.env.FBI_QUANTICO_BINARY_PATH ??
        `${process.cwd()}/cli/quantico/dist/quantico-x86_64-unknown-linux-gnu`,
    },
  },
});
