// vitest globalSetup. @appium/support (loaded through @midscene/android → appium-adb) makes one empty
// directory in the temp dir as soon as it is imported (tempdir.js: `const _static = tempDir()`) and never
// removes it, so every test worker left one behind. vitest.config.ts points APPIUM_TMP_DIR at APPIUM_TEST_TMP;
// this removes that directory once all test files have finished.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const APPIUM_TEST_TMP = join(tmpdir(), 'mta-vitest-appium');

export function teardown(): void {
  rmSync(APPIUM_TEST_TMP, { recursive: true, force: true });
}
