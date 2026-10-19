// ref: midscene-example/playwright-with-vitest-demo/vitest.config.ts (dotenv + timeouts)
// ref: node_modules/allure-vitest/README.md (reporter registration; the expected
//      vitest-pnpm-ts Allure example is absent from ref/)
// ref: midscene-example/android/vitest-demo/tests/setting.test.ts (android timeouts)
import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Browser/device + AI flows are stateful and slow; run files one at a time.
    fileParallelism: false,
    reporters: [
      'default',
      ['allure-vitest/reporter', { resultsDir: './allure-results' }],
    ],
    // `pnpm test:web` / `pnpm test:android` select one project with --project.
    projects: [
      {
        extends: true,
        test: {
          name: 'web',
          include: ['tests/web/**/*.spec.ts'],
          testTimeout: 300_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'android',
          include: ['tests/android/**/*.spec.ts'],
          testTimeout: 600_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
