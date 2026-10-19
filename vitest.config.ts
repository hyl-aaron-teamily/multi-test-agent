// ref: midscene-example/playwright-with-vitest-demo/vitest.config.ts (dotenv + timeouts)
// ref: node_modules/allure-vitest/README.md (reporter registration; the expected
//      vitest-pnpm-ts Allure example is absent from ref/)
import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Browser + AI flows are stateful and slow; run files one at a time.
    fileParallelism: false,
    reporters: [
      'default',
      ['allure-vitest/reporter', { resultsDir: './allure-results' }],
    ],
  },
});
