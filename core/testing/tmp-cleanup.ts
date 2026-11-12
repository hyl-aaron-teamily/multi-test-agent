// vitest setup file: runs in every test file, so this hook removes that file's tmpDir() directories.
import { afterAll } from 'vitest';
import { cleanTmpDirs } from './tmp-dir';

afterAll(cleanTmpDirs);
