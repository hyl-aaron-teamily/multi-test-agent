// Temporary directories for unit tests: made under the OS temp dir and removed after each test file
// (core/testing/tmp-cleanup.ts is a vitest setup file). Before W3-2 the specs left one directory per call
// behind: 1584 of them had piled up in %TEMP% by 2026-11-12.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];

/** A fresh empty directory, removed when the current test file finishes. */
export function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/** Remove every directory made by tmpDir so far. */
export function cleanTmpDirs(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}
