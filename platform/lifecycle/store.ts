// State files (W2-3 §9): everything under platform/state/ (gitignored), written atomically (temp file +
// rename), append-only NDJSON logs, a short cross-process lock for read-modify-write, and the audit log.
// Synchronous on purpose: task processes, the platform and `env recover` all touch the same files.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** platform/state, or AUTOTEST_STATE_DIR (tests). Read on every call so tests can point it elsewhere. */
export const stateRoot = () => resolve(process.env.AUTOTEST_STATE_DIR ?? 'platform/state');

export function writeJsonAtomic(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  // Windows: rename over a file another process has open for reading can fail briefly (EPERM) — retry.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 20) {
        rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(25);
    }
  }
}

export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch (e) {
      if (i >= 5) throw e;
      sleepSync(20);
    }
  }
}

export function appendLine(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(v)}\n`);
}

export function readLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return []; // a torn last line (process killed mid-write)
      }
    });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Cross-process mutex on a lock file (`wx` create). A lock older than `staleMs` is taken over (its holder
 *  died between create and remove). */
export function withLock<T>(name: string, fn: () => T, staleMs = 10_000): T {
  const f = join(stateRoot(), 'locks', `${name.replace(/[^\w.@-]/g, '_')}.lock`);
  mkdirSync(dirname(f), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      closeSync(openSync(f, 'wx'));
      break;
    } catch {
      try {
        if (Date.now() - statSync(f).mtimeMs > staleMs) rmSync(f, { force: true });
      } catch {
        /* removed meanwhile */
      }
      if (Date.now() - t0 > 30_000) throw new Error(`lock ${name}: timed out`);
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(f, { force: true });
  }
}

export interface AuditEntry {
  at: string;
  /** Who: 'platform' | 'cli' | 'policy' | 'full-access' | a reviewer name | 'recover' | 'crosscheck'. */
  by: string;
  action: string;
  object: string;
  before?: unknown;
  after?: unknown;
  basis?: string;
}

export const auditFile = () => join(stateRoot(), 'audit.ndjson');

export function audit(e: Omit<AuditEntry, 'at'>): void {
  appendLine(auditFile(), { at: new Date().toISOString(), ...e });
}

export const readAudit = () => readLines<AuditEntry>(auditFile());
