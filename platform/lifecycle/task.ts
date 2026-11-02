// Test task (W2-3 §4, F5): one approved plan run on one environment (a series = parent + N children).
// Structured files under platform/state/tasks/<id>/: task.json (record, atomic), events.ndjson (progress),
// ledger.ndjson (side effects, for the task view), result.json (final outcome). The platform
// reads these, never the log text.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcId } from './proc';
import type { Code } from './status';
import { appendLine, audit, readJson, readLines, stateRoot, withLock, writeJsonAtomic } from './store';
import { notifyFinished } from './notify';

export type TaskState = 'queued' | 'waiting-env' | 'preflight' | 'running' | 'finishing' | 'done' | 'env-unfit' | 'failed' | 'interrupted' | 'cancelled';
export const TERMINAL: TaskState[] = ['done', 'env-unfit', 'failed', 'interrupted', 'cancelled'];
/** States that need a live task process (pid + start time, §4.2). */
export const LIVE: TaskState[] = ['preflight', 'running', 'finishing'];

/** How a task ended: by itself (normal / cancel), or found ended by the platform (crash = its process exited
 *  without a terminal record; server-restart = it was gone when the platform came back). */
export type EndedBy = 'normal' | 'cancel' | 'crash' | 'server-restart';

export type Phase = 'preflight' | 'launch' | 'prepare' | 'warmup' | 'loop' | 'finishing';
export const PHASE_TEXT: Record<Phase, string> = { preflight: '预检', launch: '启动', prepare: '准备', warmup: '预热', loop: '循环', finishing: '收尾' };

export interface Position {
  phase?: Phase;
  round?: number;
  step?: number;
}

export interface TaskRecord {
  schemaVersion: 1;
  id: string;
  kind: 'issue' | 'series' | 'explore';
  /** kind explore: the quick tier's goal (capability ①). */
  explore?: { goal: string; mode: 'task' | 'explore'; writable: boolean };
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
  progress: Position & { at?: string; summary?: string; stepBudgetMs?: number };
  cancelRequested?: { at: string; by: string };
  endedBy?: EndedBy;
  endedAt?: Position;
  /** Runs cut short: valid attempts / hits so far, marked incomplete (no verdict). */
  partial?: { valid: number; hits: number; note: string };
  outcome?: { code: Code; summary: string };
  /** Report / run dir of the executor (for links). */
  runDir?: string;
  report?: string;
}

export const TASK_FLOW: Record<TaskState, TaskState[]> = {
  queued: ['waiting-env', 'cancelled'],
  'waiting-env': ['preflight', 'cancelled', 'interrupted'],
  preflight: ['running', 'finishing', 'env-unfit', 'cancelled', 'failed', 'interrupted'],
  running: ['finishing', 'env-unfit', 'cancelled', 'failed', 'interrupted'],
  finishing: ['done', 'env-unfit', 'cancelled', 'failed', 'interrupted'],
  done: [],
  'env-unfit': [],
  failed: [],
  interrupted: [],
  cancelled: [],
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
    if (isTerminal(to)) notifyFinished(t);
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

/** Side-effect record: what the task did to the environment (shown in the task view), written before the effect. */
export interface LedgerEntry {
  at: string;
  seq: number;
  kind: 'enter-conversation' | 'type' | 'send' | 'setting' | 'launch' | 'other';
  /** Conversation name / setting key. */
  target?: string;
  /** Typed / sent text (includes the run marker), setting value. */
  value?: string;
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

const END: Record<Exclude<EndedBy, 'normal'>, { state: TaskState; code: Code; text: string }> = {
  cancel: { state: 'cancelled', code: 'CANCELLED', text: '已取消' },
  crash: { state: 'interrupted', code: 'TASK_CRASHED', text: '任务进程意外退出' },
  'server-restart': { state: 'interrupted', code: 'INTERRUPTED', text: '服务重启时任务进程已不在' },
};

function stoppedAt(t: TaskRecord): string {
  const p = t.progress;
  return p.phase ? `（停在${PHASE_TEXT[p.phase] ?? p.phase}${p.round !== undefined ? ` 第 ${p.round} 轮` : ''}${p.step !== undefined ? ` 第 ${p.step} 步` : ''}）` : '';
}

/** Close a task that did not end by itself: terminal state, code, where it stopped, and the partial results
 *  marked incomplete (no verdict). A series parent takes its unfinished children with it. */
export function closeTask(id: string, endedBy: Exclude<EndedBy, 'normal'>, by: string, basis: string): TaskRecord {
  const t = getTask(id)!;
  if (isTerminal(t.state)) return t;
  const end = END[endedBy];
  const r = readResult<{ runs?: { attempts?: { valid: number; hits: number } }[] }>(id);
  const valid = r?.runs?.reduce((n, x) => n + (x.attempts?.valid ?? 0), 0);
  const hits = r?.runs?.reduce((n, x) => n + (x.attempts?.hits ?? 0), 0);
  const to: TaskState = t.state === 'queued' || t.state === 'waiting-env' ? (endedBy === 'cancel' ? 'cancelled' : 'interrupted') : end.state;
  const closed = moveTask(id, to, by, basis, (x) => {
    x.endedBy = endedBy;
    x.endedAt = { phase: x.progress.phase, round: x.progress.round, step: x.progress.step };
    x.outcome = { code: end.code, summary: `${end.text}${stoppedAt(x)}` };
    if (valid !== undefined) x.partial = { valid, hits: hits ?? 0, note: '不完整，不给结论' };
  });
  for (const c of listTasks()) if (c.parent === id && !isTerminal(c.state)) closeTask(c.id, endedBy, by, `parent ${id}: ${basis}`);
  return closed;
}
