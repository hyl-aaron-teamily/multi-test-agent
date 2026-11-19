// vitest setup file: runs in every test file, so this hook removes that file's tmpDir() directories.
// W3-4 E1: tests never restore an emulator.
import { afterAll } from 'vitest';
import { cleanTmpDirs } from './tmp-dir';

process.env.AUTOTEST_EMULATOR_RESTORE ??= '0';

afterAll(cleanTmpDirs);
