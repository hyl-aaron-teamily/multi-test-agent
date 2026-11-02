import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure checks only (no device, no model); one file at a time keeps shared state files sane.
    fileParallelism: false,
    // Unit tests read a committed fixture, never the private allow-list of this machine.
    env: { CONVERSATIONS_FILE: 'issue/__fixtures__/conversations.yaml' },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['platform/**/*.spec.ts', 'issue/**/*.spec.ts', 'skills/**/*.spec.ts', 'drivers/**/*.spec.ts', 'engine/**/*.spec.ts', 'core/**/*.spec.ts'],
        },
      },
    ],
  },
});
