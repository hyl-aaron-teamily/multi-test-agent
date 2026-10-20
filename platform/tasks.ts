// Task records (platform/state/tasks.json) + scheduler.
// Each task is one child process `node tsx bin/autotest.ts <type> ... --device <udid>`; the pool decides
// which device and how many at once. Queue is FIFO; a 2 s tick starts queued tasks when a device frees up.
// Every task has a server-side hard limit too (mission: maxMinutes + 5; explore/monkey: TASK_HARD_MINUTES).
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DevicePool } from './device-pool';

export type TaskType = 'mission' | 'explore' | 'monkey';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskInput {
  type: TaskType;
  package: string;
  device?: string;
  request?: string; // mission
  maxSteps?: number;
  maxMinutes?: number;
  seed?: number; // monkey
  events?: number; // monkey
  steps?: number; // explore
}

export interface Task extends TaskInput {
  id: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  assignedDevice?: string;
  exitCode?: number | null;
  logFile: string;
  reportFile?: string;
  verdict?: string;
  findings?: number;
}

export const STATE_DIR = resolve('platform/state');
const TASKS_FILE = join(STATE_DIR, 'tasks.json');
const TSX = resolve('node_modules/tsx/dist/cli.mjs');

/** Pure: validate a POST body. Returns an error string or the clean input. */
export function validateTaskInput(b: any): TaskInput | string {
  if (!b || typeof b !== 'object') return 'body must be JSON';
  if (!['mission', 'explore', 'monkey'].includes(b.type)) return 'type must be mission | explore | monkey';
  const pkg = String(b.package ?? '').trim();
  if (!/^[a-zA-Z][\w]*(\.[\w]+)+$/.test(pkg)) return 'package must be an Android package name';
  if (b.type === 'mission' && !String(b.request ?? '').trim()) return 'mission needs a natural-language request';
  const pos = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const out: TaskInput = { type: b.type, package: pkg };
  if (b.device) out.device = String(b.device);
  if (b.request) out.request = String(b.request).slice(0, 500);
  for (const k of ['maxSteps', 'maxMinutes', 'seed', 'events', 'steps'] as const) {
    const n = pos(b[k]);
    if (n !== undefined) {
      if (!Number.isInteger(n) || n < 0) return `${k} must be a non-negative integer`;
      out[k] = n;
    }
  }
  return out;
}

/** Pure: CLI args for a task. */
export function taskArgs(t: Task, udid: string): string[] {
  const a = ['bin/autotest.ts', t.type];
  if (t.type === 'mission') a.push(t.request!, '--id', t.id);
  a.push('--package', t.package, '--device', udid);
  if (t.type === 'mission') {
    if (t.maxSteps) a.push('--max-steps', String(t.maxSteps));
    if (t.maxMinutes) a.push('--max-minutes', String(t.maxMinutes));
  }
  if (t.type === 'monkey') {
    if (t.seed !== undefined) a.push('--seed', String(t.seed));
    if (t.events) a.push('--events', String(t.events));
  }
  if (t.type === 'explore' && t.steps) a.push('--steps', String(t.steps));
  return a;
}

export class TaskManager {
  tasks: Task[] = [];
  private procs = new Map<string, ChildProcess>();
  private timer?: NodeJS.Timeout;

  constructor(private pool: DevicePool) {}

  async load(): Promise<void> {
    await mkdir(join(STATE_DIR, 'logs'), { recursive: true });
    await mkdir(join(STATE_DIR, 'reports'), { recursive: true });
    if (existsSync(TASKS_FILE)) this.tasks = JSON.parse(await readFile(TASKS_FILE, 'utf8'));
    // Server restarted mid-run: those children are gone.
    for (const t of this.tasks) if (t.status === 'running' || t.status === 'queued') Object.assign(t, { status: 'failed', verdict: 'server restarted while task was active', finishedAt: new Date().toISOString() });
    await this.save();
  }

  private async save(): Promise<void> {
    await writeFile(TASKS_FILE, JSON.stringify(this.tasks, null, 2));
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  async create(input: TaskInput): Promise<Task> {
    const id = `t-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
    const t: Task = { ...input, id, status: 'queued', createdAt: new Date().toISOString(), logFile: join(STATE_DIR, 'logs', `${id}.log`) };
    this.tasks.unshift(t);
    await this.save();
    void this.tick();
    return t;
  }

  async cancel(id: string): Promise<boolean> {
    const t = this.get(id);
    if (!t) return false;
    if (t.status === 'queued') {
      Object.assign(t, { status: 'cancelled', finishedAt: new Date().toISOString() });
      await this.save();
      return true;
    }
    const p = this.procs.get(id);
    if (!p?.pid) return false;
    t.verdict = 'cancelled by user';
    killTree(p.pid);
    return true;
  }

  start(intervalMs = 2_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    await this.pool.refresh();
    for (const t of [...this.tasks].reverse()) {
      if (t.status !== 'queued') continue;
      const dev = this.pool.acquire(t.id, t.device);
      if (!dev) continue;
      this.launch(t, dev.udid);
    }
  }

  private launch(t: Task, udid: string): void {
    Object.assign(t, { status: 'running', startedAt: new Date().toISOString(), assignedDevice: udid });
    void this.save();
    const log = createWriteStream(t.logFile);
    log.write(`$ autotest ${taskArgs(t, udid).slice(1).join(' ')}\n`);
    const child = spawn(process.execPath, [TSX, ...taskArgs(t, udid)], { env: { ...process.env, MIDSCENE_REPORT_QUIET: 'true' } });
    this.procs.set(t.id, child);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const hardMinutes = t.type === 'mission' ? (t.maxMinutes ?? 30) + 5 : Number(process.env.TASK_HARD_MINUTES ?? 60);
    const hard = setTimeout(() => {
      log.write(`\n[platform] hard limit ${hardMinutes} min reached, killing task\n`);
      if (child.pid) killTree(child.pid);
    }, hardMinutes * 60_000);
    child.on('close', async (code) => {
      clearTimeout(hard);
      this.procs.delete(t.id);
      log.end();
      this.pool.release(udid);
      await this.finish(t, code);
      void this.tick();
    });
  }

  private async finish(t: Task, code: number | null): Promise<void> {
    t.exitCode = code;
    t.finishedAt = new Date().toISOString();
    const out = join(STATE_DIR, 'reports', `${t.id}.md`);
    try {
      if (t.type === 'mission') {
        const dir = resolve('midscene_run/missions', t.id);
        const rec = JSON.parse(await readFile(join(dir, 'mission.json'), 'utf8'));
        t.reportFile = join(dir, 'report.md');
        t.verdict = rec.verdict;
        t.findings = rec.result.findings.length;
      } else {
        // explore / monkey: build the W3 problem report from the artifacts this task just wrote.
        await new Promise<void>((r) => spawn(process.execPath, [TSX, 'report/problem-report.ts'], { stdio: 'ignore' }).on('close', () => r()));
        await copyFile(resolve('midscene_run/problem-report.md'), out);
        t.reportFile = out;
        const log = await readFile(t.logFile, 'utf8');
        t.verdict = log.match(/\[(?:explore|monkey)\] ((?:未捕获崩溃|\d+ crash).*)/)?.[1] ?? `exit ${code}`;
      }
    } catch (err) {
      t.verdict ??= `no report (${(err as Error).message.split('\n')[0]})`;
    }
    // Exit 1 from mission/explore/monkey means "found a problem", which is a completed run.
    const killed = t.verdict === 'cancelled by user';
    t.status = killed ? 'cancelled' : code === 0 || (code === 1 && t.reportFile) ? 'completed' : 'failed';
    await this.save();
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-pid, 'SIGTERM');
}
