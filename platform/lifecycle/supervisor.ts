// Platform side of tasks and environments (W2-3 §3–4, refactor P2): schedules queued tasks onto ready
// environments (FIFO, one lease per environment, one task per phone), spawns `autotest task exec`, closes
// tasks whose process ended without a terminal record, and checks an environment again when its lease ends.
// Liveness is the task process only (pid + start time recorded in the lease): no heartbeat, no watchdog.
// A cancel stops at the next step boundary; a process that has not stopped CANCEL_KILL_MS later is killed.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountPool } from '../accounts/account-pool';
import type { DevicePool } from '../device-pool';
import { checkEnv } from './check';
import { endLease, getEnv, leaseEnv, listEnvs, moveEnv } from './env';
import { alive, killTree, type ProcId } from './proc';
import { prodDrivers, syncEnvs } from './registry';
import { closeTask, event, getTask, isTerminal, LIVE, listTasks, moveTask, taskDir, taskEnvs, type TaskRecord, updateTask } from './task';

export const CANCEL_KILL_MS = Number(process.env.AUTOTEST_CANCEL_KILL_MS ?? 60_000);
/** A task started outside the platform that has not bound its lease this long after the start did not start. */
const OUTSIDE_START_MS = 90_000;
const RECHECK_MS = 30_000;

export interface Reconciled {
  task: string;
  env?: string;
  action: 'adopted' | 'requeued' | 'closed' | 'released';
}

/** Platform start: leases left by a previous run are kept only while their task process (pid + start time) is
 *  alive; tasks in a live state without a lease cannot be running and are closed. Pure over the state files. */
export function reconcile(isAlive: (p: ProcId | undefined) => boolean = (p) => alive(p), kill: (pid: number) => void = killTree): Reconciled[] {
  const out: Reconciled[] = [];
  for (const e of listEnvs()) {
    if (!e.lease) continue;
    const t = getTask(e.lease.taskId);
    if (t && !isTerminal(t.state) && isAlive(e.lease.proc ?? t.proc)) {
      out.push({ task: t.id, env: e.id, action: 'adopted' });
      continue;
    }
    if (t && (t.state === 'queued' || t.state === 'waiting-env')) {
      endLease(e.id, t.id, { by: 'platform', basis: `lease holder ${t.id} never started: requeued` });
      out.push({ task: t.id, env: e.id, action: 'requeued' });
      continue;
    }
    if (t && !isTerminal(t.state)) closeTask(t.id, 'server-restart', 'platform', 'task process gone at platform start');
    endLease(e.id, e.lease.taskId, { by: 'platform', basis: `lease holder ${e.lease.taskId} ${t ? 'ended' : 'missing'}` });
    out.push({ task: e.lease.taskId, env: e.id, action: t && getTask(t.id)!.endedBy === 'server-restart' ? 'closed' : 'released' });
  }
  for (const t of listTasks()) {
    if (!LIVE.includes(t.state) || getEnv(t.envId)?.lease?.taskId === t.id || t.parent) continue;
    if (isAlive(t.proc)) kill(t.proc!.pid);
    closeTask(t.id, 'server-restart', 'platform', 'live state without a lease at platform start');
    out.push({ task: t.id, env: t.envId, action: 'closed' });
  }
  return out;
}

export class Supervisor {
  private timers: NodeJS.Timeout[] = [];
  private checking = new Set<string>();
  private children = new Map<string, number>();
  private busy = false;
  private lastRecheck = 0;
  log: (s: string) => void = (s) => console.log(`[supervisor] ${s}`);

  constructor(
    private devices: DevicePool,
    private accounts: AccountPool,
  ) {}

  /** Registry, then the leases left by a previous platform run; the check of every free environment runs in the
   *  background (W2-5 §9: the platform answers at once; tasks wait for their environment to be ready). */
  async start(): Promise<void> {
    syncEnvs(this.devices.config, this.accounts);
    for (const a of reconcile()) {
      this.log(`start: ${a.task} on ${a.env ?? '-'} ${a.action}`);
      const e = a.env ? getEnv(a.env) : undefined;
      if (a.action === 'adopted' && e?.udid) this.devices.acquire(a.task, e.udid, e.surface);
    }
    const free = listEnvs().filter((e) => !e.lease);
    for (const e of free) if (e.state !== 'checking' && e.state !== 'offline') moveEnv(e.id, 'checking', { by: 'platform', basis: 'platform start' });
    this.startupChecks = (async () => {
      for (const e of free) await this.check(e.id);
    })();
    this.timers.push(setInterval(() => void this.tick(), 2000));
    this.timers.push(setInterval(() => void this.watch(), 5000));
  }

  /** The start-up checks (tests, shutdown wait for them). */
  startupChecks: Promise<void> = Promise.resolve();

  /** Check an environment (one at a time per environment). */
  async check(envId: string, by = 'platform'): Promise<void> {
    if (this.checking.has(envId)) return;
    this.checking.add(envId);
    try {
      const e = getEnv(envId);
      if (e?.state === 'offline') moveEnv(envId, 'checking', { by, basis: 'check requested' });
      const r = await checkEnv(envId, prodDrivers, by);
      if (r.env.state !== 'ready') this.log(`check ${envId}: ${r.env.state}${r.env.reason ? ` — ${r.env.reason}` : ''}`);
    } catch (err) {
      this.log(`check ${envId}: ${(err as Error).message}`);
    } finally {
      this.checking.delete(envId);
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.devices.refresh();
      for (const t of listTasks().reverse()) {
        if (t.state === 'queued') moveTask(t.id, 'waiting-env', 'platform', 'scheduler');
        if (getTask(t.id)!.state !== 'waiting-env' || t.parent) continue;
        if (!this.leaseAll(t)) continue;
        this.launch(t.id);
      }
      // Unfit / offline-by-check environments are checked again every 30 s (e.g. after the phone was unlocked).
      if (Date.now() - this.lastRecheck > RECHECK_MS) {
        this.lastRecheck = Date.now();
        for (const e of listEnvs()) if (e.state === 'unfit' || e.state === 'checking') await this.check(e.id);
      }
    } catch (e) {
      this.log(`tick: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Lease every environment of the task, or none (§6): all ready, none being checked, their phones idle and
   *  not leased by another task (one task per phone; a sync task may hold the App and the browser of one phone). */
  private leaseAll(t: TaskRecord): boolean {
    const ids = taskEnvs(t);
    const envs = ids.map((id) => getEnv(id));
    if (envs.some((e) => !e || e.state !== 'ready' || this.checking.has(e.id))) return false;
    for (const env of envs) {
      if (!env!.udid) continue;
      const dev = this.devices.get(env!.udid);
      if (!dev || dev.status !== 'idle' || listEnvs().some((e) => e.udid === env!.udid && !ids.includes(e.id) && e.lease)) return false;
    }
    const got: string[] = [];
    for (const env of envs) {
      if (!leaseEnv(env!.id, t.id)) {
        for (const g of got) endLease(g, t.id, { by: 'platform', basis: `task ${t.id}: not every environment could be leased` });
        return false;
      }
      got.push(env!.id);
    }
    for (const env of envs) if (env!.udid) this.devices.acquire(t.id, env!.udid, env!.surface);
    return true;
  }

  /** Tasks started outside the platform's process tree (Windows), with when: ended by watch() on their pid. */
  private readonly outside = new Map<string, number>();

  private launch(id: string): void {
    // Windows: pnpm keeps its children in a job that is killed when pnpm exits, and a detached child stays in
    // it (2026-11-03: stopping the platform killed the running task). Start the task process through WMI, which
    // creates it outside that job, so a restarted platform can adopt it (W2-5 §9).
    if (process.platform === 'win32' && !process.env.VITEST && process.env.AUTOTEST_TASK_SPAWN !== 'child' && this.launchOutside(id)) return;
    // Elsewhere (and as a fallback):
    // The task process outlives the platform (W2-5 §9): its own process group (a Ctrl+C in the platform's terminal
    // does not reach it) and its output straight into task.log (no pipe to a parent that may go away). A
    // restarted platform adopts it (reconcile: pid + start time).
    const log = openSync(join(taskDir(id), 'task.log'), 'a');
    // node --import tsx: one process (the tsx command line would add a launcher that dies with its parent).
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/task-exec.ts', id], { env: { ...process.env, MIDSCENE_REPORT_QUIET: 'true' }, windowsHide: true, detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    this.children.set(id, child.pid ?? 0);
    event(id, { type: 'note', note: `spawned pid ${child.pid}` });
    child.on('exit', (code) => {
      this.children.delete(id);
      void this.ended(id, code);
    });
  }

  /** Windows: the task process through WMI (Win32_Process.Create), output appended to task.log. Only
   *  AUTOTEST_* variables are passed on (the task reads .env itself; no secrets on a command line). */
  private launchOutside(id: string): boolean {
    const log = join(taskDir(id), 'task.log');
    const vars = Object.entries(process.env)
      .filter(([k, v]) => /^AUTOTEST_/.test(k) && v !== undefined && !/["&|<>^%\r\n]/.test(v))
      .map(([k, v]) => `set "${k}=${v}"&& `)
      .join('');
    const line = `cmd.exe /d /s /c "${vars}set "MIDSCENE_REPORT_QUIET=true"&& "${process.execPath}" --import tsx scripts/task-exec.ts ${id} >> "${log}" 2>&1"`;
    const q = (s: string) => s.replace(/'/g, "''");
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(line)}'; CurrentDirectory = '${q(process.cwd())}' }; "$($r.ReturnValue) $($r.ProcessId)"`;
    try {
      const [rv, pid] = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim().split(/\s+/);
      if (rv !== '0') throw new Error(`Win32_Process.Create returned ${rv}`);
      this.outside.set(id, Date.now());
      event(id, { type: 'note', note: `spawned outside the platform (WMI), cmd pid ${pid}` });
      return true;
    } catch (e) {
      this.log(`task ${id}: could not start it outside the platform (${(e as Error).message.split('\n')[0]}) — starting it as a child`);
      return false;
    }
  }

  /** The task process exited: close the record if it did not end itself, release, check the environment. */
  private async ended(id: string, code: number | null): Promise<void> {
    const t = getTask(id)!;
    if (!isTerminal(t.state)) closeTask(id, t.cancelRequested ? 'cancel' : 'crash', 'platform', `task process exited (code ${code}) in ${t.state}`);
    // Every environment is released and checked on its own.
    const ended: string[] = [];
    for (const envId of taskEnvs(t)) {
      const env = getEnv(envId);
      if (env?.udid) this.devices.release(env.udid, undefined, id);
      if (env?.lease?.taskId === id) {
        endLease(envId, id, { by: 'platform', basis: `task ${id} ended (${getTask(id)!.state})` });
        ended.push(envId);
      }
    }
    for (const envId of ended) await this.check(envId);
    void this.tick();
  }

  /** Adopted tasks (not our children) and cancels that did not stop: decided by the process alone. */
  private async watch(): Promise<void> {
    try {
      for (const e of listEnvs()) {
        if (!e.lease) continue;
        const t = getTask(e.lease.taskId);
        if (!t) continue;
        const proc = e.lease.proc ?? t.proc;
        const mine = this.children.has(t.id);
        if (proc && t.cancelRequested && !isTerminal(t.state) && Date.now() - Date.parse(t.cancelRequested.at) > CANCEL_KILL_MS && alive(proc)) {
          this.log(`task ${t.id}: no stop ${CANCEL_KILL_MS / 1000} s after cancel — killing pid ${proc.pid}`);
          killTree(proc.pid);
        }
        if (mine) continue; // our child: its 'close' event ends it
        // Started outside (WMI) but never bound its lease: it did not start.
        const started = this.outside.get(t.id);
        const neverRan = !proc && started !== undefined && Date.now() - started > OUTSIDE_START_MS;
        if (isTerminal(t.state) || (proc && !alive(proc)) || neverRan) {
          this.outside.delete(t.id);
          await this.ended(t.id, null);
        }
      }
    } catch (e) {
      this.log(`watch: ${(e as Error).message}`);
    }
  }

  async cancel(id: string, by: string): Promise<boolean> {
    const t = getTask(id);
    if (!t || isTerminal(t.state)) return false;
    if (t.state === 'queued' || t.state === 'waiting-env') {
      closeTask(id, 'cancel', by, 'cancelled before start');
      return true;
    }
    updateTask(id, (x) => void (x.cancelRequested = { at: new Date().toISOString(), by }));
    event(id, { type: 'note', note: `cancel requested by ${by}` });
    return true;
  }

  /** Ctrl+C / SIGTERM: stop scheduling. Running task processes keep their lease and are adopted (or closed)
   *  on the next start. */
  async shutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
  }
}
