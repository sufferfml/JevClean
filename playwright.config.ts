import { defineConfig } from '@playwright/test';
const port = Number(process.env.JEVCLEAN_UI_PORT ?? 5178);
export default defineConfig({ testDir: './tests/ui', testMatch: '*.spec.ts', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:' + port, viewport: { width: 1320, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npx tsx tests/ui/server.ts', url: 'http://127.0.0.1:' + port, reuseExistingServer: false },
});
