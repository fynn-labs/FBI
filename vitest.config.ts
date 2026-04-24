import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      ['src/web/**', 'happy-dom'],
    ],
    setupFiles: ['./src/web/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@ui': path.resolve(__dirname, 'src/web/ui'),
      '@tauri-apps/plugin-clipboard-manager': path.resolve(__dirname, 'src/web/lib/__mocks__/tauri-clipboard.ts'),
    },
  },
});
