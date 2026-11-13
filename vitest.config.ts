import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import { APPIUM_TEST_TMP } from './core/testing/appium-tmp';

export default defineConfig({
  test: {
    // Pure checks only (no device, no model); one file at a time keeps shared state files sane.
    fileParallelism: false,
    // Every test file's tmpDir() directories are removed when it finishes.
    setupFiles: ['core/testing/tmp-cleanup.ts'],
    // @appium/support's import-time temp directory goes under one folder, removed after the run.
    globalSetup: ['core/testing/appium-tmp.ts'],
    // Unit tests read a committed fixture, never the private allow-list of this machine.
    env: { CONVERSATIONS_FILE: 'issue/__fixtures__/conversations.yaml', AUTOTEST_ISSUES_DIR: 'fixtures/issues', AUTOTEST_DRAFTS_DIR: 'issue/__fixtures__/drafts', APPIUM_TMP_DIR: APPIUM_TEST_TMP },
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
