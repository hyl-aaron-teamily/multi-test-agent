// Test task (W2-3 §4, F5): one approved plan run on one environment (a series = parent + N children).
// Structured files under platform/state/tasks/<id>/: task.json (record, atomic), events.ndjson (progress),
// ledger.ndjson (side effects, written BEFORE each effect — G6), result.json (final outcome). The platform
// reads these, never the log text.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcId } from './proc';
import type { Code } from './status';
import { appendLine, audit, readJson, readLines, stateRoot, withLock, writeJsonAtomic } from './store';

export type TaskState = 'queued' | 'waiting-env' | 'preflight' | 'running' | 'finishing' | 'recovering' | 'done' | 'env-unfit' | 'failed' | 'interrupted' | 'cancelled' | 'timed-out';
export const TERMINAL: TaskState[] = ['done', 'env-unfit', 'failed', 'interrupted', 'cancelled', 'timed-out'];
/** States that need a live process with a fresh heartbeat (§4.2). */
export const LIVE: TaskState[] = ['preflight', 'running', 'finishing'];

export type EndedBy = 'normal' | 'cancel' | 'timeout' | 'stuck' | 'crash' | 'env-offline' | 'server-restart';

export type Phase = 'preflight' | 'launch' | 'prepare' | 'warmup' | 'loop' | 'finishing' | 'recovery';
export const PHASE_TEXT: Record<Phase, string> = { preflight: '预检', launch: '启动', prepare: '准备', warmup: '预热', loop: '循环', finishing: '收尾', recovery: '恢复' };

export interface Position {
  phase?: Phase;
  round?: number;
  step?: number;
}

export interface TaskRecord {
  schemaVersion: 1;
  id: string;
  kind: 'issue' | 'series';
  issue: string;
  /** Plan ids `<Issue>/<sub>:<surface>@<version>`, and the approval they run under. */
  planId: string;
  planHash: string;
  approvalId?: string;
  envId: string;
  parent?: string;
  series?: { runs: number };
  options: { maxRounds?: number; maxSteps?: number; maxMinutes?: number; dryRun?: boolean };
  idempotencyKey?: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  proc?: ProcId;
  heartbeatAt?: string;
  progress: Position & { at?: string; summary?: string; stepBudgetMs?: number };
  cancelRequested?: { at: string; by: string };
  endedBy?: EndedBy;
  endedAt?: Position;
  /** Runs cut short: valid attempts / hits so far, marked incomplete (no verdict). */
  partial?: { valid: number; hits: number; note: string };
  recovery?: { result: 'recovered' | 'quarantined' | 'unfit' | 'pending'; reason?: string; at: string; steps?: string[] };
  outcome?: { code: Code; summary: string };
  /** Report / run dir of the executor (for links). */
  runDir?: string;
  report?: string;
}

export const TASK_FLOW: Record<TaskState, TaskState[]> = {
  queued: ['waiting-env', 'cancelled'],
  'waiting-env': ['preflight', 'cancelled', 'interrupted'],
  preflight: ['running', 'env-unfit', 'recovering', 'finishing'],
  running: ['finishing', 'recovering'],
  finishing: ['done', 'recovering'],
  recovering: ['failed', 'interrupted', 'cancelled', 'timed-out', 'done', 'env-unfit'],
  done: [],
  'env-unfit': [],
  failed: [],
  interrupted: [],
  cancelled: [],
  'timed-out': [],
};

export const isTerminal = (s: TaskState) => TERMINAL.includes(s);

export const taskDir = (id: string) => join(stateRoot(), 'tasks', id);
const taskFile = (id: string) => join(taskDir(id), 'task.json');

export const newTaskId = () => `t-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

export function getTask(id: string): TaskRecord | undefined {
  return readJson<TaskRecord>(taskFile(id));
}

export function listTasks(): TaskRecord[] {
  const dir = join(stateRoot(), 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((d) => getTask(d))
    .filter((t): t is TaskRecord => !!t)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createTask(t: Omit<TaskRecord, 'schemaVersion' | 'state' | 'createdAt' | 'updatedAt' | 'progress'> & { progress?: TaskRecord['progress'] }): TaskRecord {
  const now = new Date().toISOString();
  const rec: TaskRecord = { schemaVersion: 1, progress: {}, ...t, state: 'queued', createdAt: now, updatedAt: now };
  withLock(`task-${t.id}`, () => {
    if (existsSync(taskFile(t.id))) throw new Error(`task ${t.id} exists`);
    writeJsonAtomic(taskFile(t.id), rec);
  });
  audit({ by: 'platform', action: 'task.create', object: t.id, after: 'queued', basis: `${t.planId} on ${t.envId}` });
  event(t.id, { type: 'state', state: 'queued' });
  return rec;
}

export function updateTask(id: string, fn: (t: TaskRecord) => TaskRecord | void): TaskRecord {
  return withLock(`task-${id}`, () => {
    const t = getTask(id);
    if (!t) throw new Error(`no task ${id}`);
    const next = (fn(t) ?? t) as TaskRecord;
    next.updatedAt = new Date().toISOString();
    writeJsonAtomic(taskFile(id), next);
    return next;
  });
}

export class TaskTransitionError extends Error {}

/** One state transition; illegal ones throw (a terminal record is never rewritten). */
export function moveTask(id: string, to: TaskState, by: string, basis: string, patch?: (t: TaskRecord) => void): TaskRecord {
  let before: TaskState | undefined;
  const t = updateTask(id, (t) => {
    before = t.state;
    if (t.state === to) return patch?.(t);
    if (!TASK_FLOW[t.state].includes(to)) throw new TaskTransitionError(`task ${id}: ${t.state} → ${to} not allowed`);
    t.state = to;
    if (to === 'preflight') t.startedAt ??= new Date().toISOString();
    if (isTerminal(to)) t.finishedAt = new Date().toISOString();
    patch?.(t);
  });
  if (before !== to) {
    audit({ by, action: 'task.move', object: id, before, after: to, basis });
    event(id, { type: 'state', state: to, basis });
  }
  return t;
}

export interface TaskEvent {
  at: string;
  type: 'state' | 'progress' | 'log' | 'round' | 'note';
  [k: string]: unknown;
}

export function event(id: string, e: Omit<TaskEvent, 'at'>): void {
  appendLine(join(taskDir(id), 'events.ndjson'), { at: new Date().toISOString(), ...e });
}
export const readEvents = (id: string) => readLines<TaskEvent>(join(taskDir(id), 'events.ndjson'));

/** Side-effect ledger entry (G6): written before the effect. `done` follows when the effect returned. */
export interface LedgerEntry {
  at: string;
  seq: number;
  kind: 'enter-conversation' | 'type' | 'send' | 'setting' | 'launch' | 'other';
  /** Conversation name / setting key. */
  target?: string;
  /** Typed / sent text (includes the run marker), setting value. */
  value?: string;
  /** Point the conversation was entered at (recovery reopens it by name first). */
  point?: { x: number; y: number };
  phase?: Phase;
  round?: number;
  state: 'intent' | 'done';
}

export const ledgerFile = (id: string) => join(taskDir(id), 'ledger.ndjson');
export const readLedger = (id: string) => readLines<LedgerEntry>(ledgerFile(id));

export function writeResult(id: string, r: unknown): void {
  writeJsonAtomic(join(taskDir(id), 'result.json'), r);
}
export const readResult = <T = unknown>(id: string) => readJson<T>(join(taskDir(id), 'result.json'));
