// vitest setup file: runs in every test file, so this hook removes that file's tmpDir() directories.
// W3-5: tests never read or write the project's lessons, never call a memory service, never restore an emulator.
import { afterAll } from 'vitest';
import { cleanTmpDirs, tmpDir } from './tmp-dir';

process.env.MEMORY_OFF ??= '1';
process.env.AUTOTEST_MEMORY_DIR ??= tmpDir('mta-memory-');
process.env.AUTOTEST_REPLAY_DIR ??= tmpDir('mta-replay-');
process.env.AUTOTEST_EMULATOR_RESTORE ??= '0';
process.env.MEMORY_CORE_IDS_FILE ??= 'no-such-memory-ids.json';
process.env.MEMORY_CORE_KEY_FILE ??= 'no-such-memory-key';
process.env.AUTOTEST_LESSON_MODEL ??= '0';
process.env.AUTOTEST_PAGES_FILE ??= 'no-such-pages.local.json';

afterAll(cleanTmpDirs);
