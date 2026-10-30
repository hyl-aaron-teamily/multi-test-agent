// Structured task output for the console's legacy task types (W2-3 T4): a child started by the platform
// gets AUTOTEST_RESULT_FILE and writes its report / artifact / verdict there, so the platform never has to
// parse log text. Without the variable (a person running the command) nothing is written.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LegacyTaskResult {
  /** Report markdown of the run. */
  report?: string;
  /** explore trace / monkey run summary the platform builds its problem report from. */
  artifact?: string;
  verdict?: string;
  findings?: number;
}

export function emitTaskResult(r: LegacyTaskResult): void {
  const f = process.env.AUTOTEST_RESULT_FILE;
  if (!f) return;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(r, null, 2));
  renameSync(`${f}.tmp`, f);
}
