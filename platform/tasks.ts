// Task records (platform/state/tasks.json) + scheduler.
// Each task is one child process `node tsx bin/autotest.ts <type> ... --device <udid>`; the pool decides
// which device and how many at once. Queue is FIFO; a 2 s tick starts queued tasks when a device frees up.
// Every task has a server-side hard limit too (mission: maxMinutes + 5; others: TASK_HARD_MINUTES).
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DevicePool } from './device-pool';

export type TaskType = 'mission' | 'explore' | 'monkey' | 'imui' | 'issue' | 'sync';
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
  conversation?: string; // imui: conversation name on the device (and on web)
  web?: 'test' | 'prod'; // imui: also watch from chat-web with this env's saved login
  duration?: number; // imui
  rate?: number; // imui, msgs/s per sender
  msgTypes?: string; // imui
  yesProd?: boolean; // imui: explicit production confirmation
  issue?: string; // issue: issues/<id>.md
  approve?: string; // issue: confirmed sub-cases "s1,s3:mobile-web" (the one-time confirmation)
  env?: 'test' | 'prod'; // issue, sync
  roles?: string; // sync: surfaces, one client each ("desktop-web,android-web,android-app")
  rounds?: number; // sync
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
  if (!['mission', 'explore', 'monkey', 'imui', 'issue', 'sync'].includes(b.type)) return 'type must be mission | explore | monkey | imui | issue | sync';
  if (b.type === 'sync') {
    const S = '(android-app|android-web|mobile-web|desktop-web)(#[0-9])?';
    const roles = String(b.roles ?? 'desktop-web,android-web,android-app').replace(/\s/g, '');
    if (!new RegExp(`^${S}(,${S})+$`).test(roles)) return 'roles: two or more of android-app, android-web, mobile-web, desktop-web (comma separated)';
    const rounds = b.rounds === undefined || b.rounds === '' ? undefined : Number(b.rounds);
    if (rounds !== undefined && !(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20)) return 'rounds must be 1..20';
    const env = b.env ?? 'prod';
    if (!['test', 'prod'].includes(env)) return 'env must be test or prod';
    return { type: 'sync', package: 'ai.teamily.mobile', roles, env, ...(rounds ? { rounds } : {}) };
  }
  if (b.type === 'issue') {
    const issue = String(b.issue ?? '').trim();
    if (!/^[\w-]+$/.test(issue)) return 'issue must be an issue id (issues/<id>.md)';
    const approve = String(b.approve ?? '').trim();
    if (!/^(all|[\w]+(:(android-app|mobile-web|desktop-web))?(,[\w]+(:(android-app|mobile-web|desktop-web))?)*)?$/.test(approve)) return 'approve: s1,s2:mobile-web | all';
    const env = b.env ?? 'prod';
    if (!['test', 'prod'].includes(env)) return 'env must be test or prod';
    const out: TaskInput = { type: 'issue', package: 'ai.teamily.mobile', issue, approve: approve || 'all', env };
    if (b.device) out.device = String(b.device);
    for (const k of ['maxSteps', 'maxMinutes'] as const) if (b[k] !== undefined && b[k] !== '') out[k] = Number(b[k]);
    return out;
  }
  const pkg = String(b.package ?? '').trim();
  if (!/^[a-zA-Z][\w]*(\.[\w]+)+$/.test(pkg)) return 'package must be an Android package name';
  if (b.type === 'mission' && !String(b.request ?? '').trim()) return 'mission needs a natural-language request';
  if (b.type === 'imui') {
    const conv = String(b.conversation ?? '').trim();
    if (!conv) return 'imui needs the conversation to send into (no default chat)';
    if (b.web && !['test', 'prod'].includes(b.web)) return 'web must be test or prod';
    const rate = b.rate === undefined || b.rate === '' ? undefined : Number(b.rate);
    if (rate !== undefined && !(rate > 0 && rate <= 2)) return 'rate must be in (0, 2]';
    if (b.msgTypes && !/^(text|long)(,(text|long))*$/.test(String(b.msgTypes))) return 'msgTypes: text and/or long';
  }
  const pos = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const out: TaskInput = { type: b.type, package: pkg };
  if (b.device) out.device = String(b.device);
  if (b.request) out.request = String(b.request).slice(0, 500);
  if (b.type === 'imui') {
    out.conversation = String(b.conversation).trim().slice(0, 120);
    if (b.web) out.web = b.web;
    if (b.rate !== undefined && b.rate !== '') out.rate = Number(b.rate);
    if (b.msgTypes) out.msgTypes = String(b.msgTypes);
    out.yesProd = b.yesProd === true;
  }
  for (const k of ['maxSteps', 'maxMinutes', 'seed', 'events', 'steps', 'duration'] as const) {
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
  // Sync tasks lease their endpoint slots themselves (one per role).
  if (t.type === 'sync') return ['bin/autotest.ts', 'sync', '--roles', t.roles ?? 'desktop-web,android-web,android-app', '--env', t.env ?? 'prod', ...(t.rounds ? ['--rounds', String(t.rounds)] : [])];
  if (t.type === 'issue') {
    const a = ['bin/autotest.ts', 'run', '--issue', t.issue!, '--approve', t.approve ?? 'all', '--env', t.env ?? 'prod', '--id', t.id];
    if (udid) a.push('--device', udid);
    if (t.maxSteps) a.push('--max-steps', String(t.maxSteps));
    if (t.maxMinutes) a.push('--max-minutes', String(t.maxMinutes));
    return a;
  }
  if (t.type === 'imui') {
    const a = ['bin/autotest.ts', 'imui', 'run', '--client', `android:${udid}@${t.conversation}`];
    if (t.web) a.push('--client', `web:${t.web}@${t.conversation}`);
    if (t.duration) a.push('--duration', String(t.duration));
    if (t.rate) a.push('--rate', String(t.rate));
    if (t.msgTypes) a.push('--msg-types', t.msgTypes);
    if (t.yesProd) a.push('--yes-prod');
    return a;
  }
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
      // Sync tasks lease one slot per role in the runner; issue tasks on web surfaces need no device.
      const dev = t.type === 'sync' ? null : this.pool.acquire(t.id, t.device);
      if (!dev && t.type !== 'issue' && t.type !== 'sync') continue;
      this.launch(t, dev?.udid ?? '');
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
    const hardMinutes = t.type === 'issue' ? (t.maxMinutes ?? 30) * 4 + 15 : t.type === 'mission' ? (t.maxMinutes ?? 30) + 5 : Number(process.env.TASK_HARD_MINUTES ?? 60);
    const hard = setTimeout(() => {
      log.write(`\n[platform] hard limit ${hardMinutes} min reached, killing task\n`);
      if (child.pid) killTree(child.pid);
    }, hardMinutes * 60_000);
    child.on('close', async (code) => {
      clearTimeout(hard);
      this.procs.delete(t.id);
      log.end();
      if (udid) this.pool.release(udid);
      await this.finish(t, code);
      void this.tick();
    });
  }

  private async finish(t: Task, code: number | null): Promise<void> {
    t.exitCode = code;
    t.finishedAt = new Date().toISOString();
    const out = join(STATE_DIR, 'reports', `${t.id}.md`);
    try {
      if (t.type === 'sync') {
        const log = await readFile(t.logFile, 'utf8');
        const file = log.match(/\[sync\] report → (.+\.md)/)?.[1]?.trim();
        if (!file) throw new Error('sync run wrote no report');
        t.reportFile = file;
        t.verdict = log.match(/\[sync\] ((?:全部同步|存在未同步|执行失败) — .+)/)?.[1] ?? `exit ${code}`;
      } else if (t.type === 'issue') {
        const log = await readFile(t.logFile, 'utf8');
        const file = log.match(/\[run\] report → (.+\.md)/)?.[1]?.trim();
        if (!file) throw new Error('issue run wrote no report');
        t.reportFile = file;
        const concl = [...log.matchAll(/\[run\] ([\w-]+-v\d+): ([^—\n]+?) —/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
        t.verdict = concl.join(' · ') || log.match(/处理: (.+)/)?.[1] || `exit ${code}`;
      } else if (t.type === 'imui') {
        const log = await readFile(t.logFile, 'utf8');
        const file = log.match(/\[imui\] report → (.+\.md)/)?.[1]?.trim();
        if (!file) throw new Error('imui wrote no report');
        t.reportFile = file;
        const head = log.match(/# imui run `\w+` — (PASS|FAIL)/)?.[1];
        const sent = log.match(/\| 发送 \| (\d+) 条/)?.[1];
        const echo = log.match(/ui_echo_ms[^|]*\| (\d+) \| [\d.]+ \| ([\d.]+)/);
        t.verdict = `${head ?? '?'} · 发送 ${sent ?? '?'} 条${echo ? ` · echo p50 ${echo[2]}ms` : ''}${code === 1 ? ' · 配置/客户端错误' : ''}`;
      } else if (t.type === 'mission') {
        const dir = resolve('midscene_run/missions', t.id);
        const rec = JSON.parse(await readFile(join(dir, 'mission.json'), 'utf8'));
        t.reportFile = join(dir, 'report.md');
        t.verdict = rec.verdict;
        t.findings = rec.result.findings.length;
      } else {
        // explore / monkey: W3 problem report from this task's own artifact only (the path printed in its log),
        // never "newest trace / monkey_run/summary.json", which may belong to another task.
        const log = await readFile(t.logFile, 'utf8');
        const artifact = (t.type === 'explore' ? log.match(/\[explore\] trace → (.+\.json)/) : log.match(/\[monkey\] run summary → (.+\.json)/))?.[1]?.trim();
        if (!artifact) throw new Error(`${t.type} wrote no ${t.type === 'explore' ? 'trace' : 'summary'}`);
        const args = ['report/problem-report.ts', '--only', t.type, t.type === 'explore' ? '--trace' : '--monkey', artifact, '--out', out];
        const err = await new Promise<string>((r) => {
          let stderr = '';
          const p = spawn(process.execPath, [TSX, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
          p.stderr.on('data', (d) => (stderr += d));
          p.on('close', (c) => r(c === 0 ? '' : stderr.trim() || `report exit ${c}`));
        });
        if (err) throw new Error(err);
        t.reportFile = out;
        t.verdict = log.match(/\[(?:explore|monkey)\] ((?:未捕获崩溃|\d+ crash).*)/)?.[1] ?? `exit ${code}`;
      }
    } catch (err) {
      t.verdict ??= `no report (${(err as Error).message.split('\n')[0]})`;
    }
    const killed = t.verdict === 'cancelled by user';
    // mission/explore/monkey: exit 1 = found a problem. imui (imload codes): 2 = SLO failed, 1 = error.
    // issue (autotest run): 0 = not reproduced / done, 1 = reproduced, 3 = execution failed / SKILL stale.
    const ok = t.type === 'sync' ? (code === 0 || code === 1) && !!t.reportFile : t.type === 'issue' ? (code === 0 || code === 1) && !!t.reportFile : t.type === 'imui' ? (code === 0 || code === 2) && !!t.reportFile : code === 0 || (code === 1 && !!t.reportFile);
    t.status = killed ? 'cancelled' : ok ? 'completed' : 'failed';
    await this.save();
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-pid, 'SIGTERM');
}
