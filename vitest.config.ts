import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure checks only (no device, no model); one file at a time keeps shared state files sane.
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['platform/**/*.spec.ts', 'issue/**/*.spec.ts', 'skills/**/*.spec.ts', 'drivers/**/*.spec.ts', 'executor/**/*.spec.ts', 'incident/**/*.spec.ts', 'core/**/*.spec.ts'],
        },
      },
    ],
  },
});
