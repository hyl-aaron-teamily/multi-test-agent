// Platform side of tasks and environments (W2-3 §3–4): schedules queued tasks onto ready environments
// (FIFO, one lease per environment, one task per phone), spawns `autotest task exec`, runs the watchdog
// (heartbeat 30 s / progress budget + 60 s / hard limit), closes tasks that ended without a terminal
// state, recovers environments in a separate `autotest env recover` process, rechecks unfit environments,
// and drains everything on Ctrl+C / SIGTERM. On start: environment registry + cross-check (L4).
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AccountPool } from '../accounts/account-pool';
import type { DevicePool } from '../device-pool';
import { closeTask, offlineEnv, onlineEnv, orphanSweep, startupCrossCheck, watchdogTick } from './crosscheck';
import { endLease, getEnv, leaseEnv, listEnvs, moveEnv } from './env';
import { prodDrivers, syncEnvs } from './registry';
import { recoverEnv } from './recover';
import { event, getTask, isTerminal, listTasks, moveTask, taskDir } from './task';

const TSX = resolve('node_modules/tsx/dist/cli.mjs');

export class Supervisor {
  private timers: NodeJS.Timeout[] = [];
  private recovering = new Set<string>();
  private children = new Map<string, number>();
  private busy = false;
  private lastRecheck = 0;
  log: (s: string) => void = (s) => console.log(`[supervisor] ${s}`);

  constructor(
    private devices: DevicePool,
    private accounts: AccountPool,
  ) {}

  /** Registry + startup cross-check, then the scheduler and watchdog ticks. */
  async start(): Promise<void> {
    syncEnvs(this.devices.config, this.accounts);
    const fixes = await startupCrossCheck({ drivers: prodDrivers, recover: (id) => this.recover(id) });
    for (const f of fixes) this.log(`cross-check: task ${f.task} ${f.action}${f.endedBy ? ` (${f.endedBy})` : ''} [${f.health}]`);
    this.timers.push(setInterval(() => void this.tick(), 2000));
    this.timers.push(setInterval(() => void this.watch(), 5000));
  }

  /** Recover an environment in its own process (§4.3 L3); one at a time per environment. */
  recover(envId: string): Promise<void> {
    if (this.recovering.has(envId)) return Promise.resolve();
    this.recovering.add(envId);
    return new Promise((res) => {
      const p = spawn(process.execPath, [TSX, 'bin/autotest.ts', 'env', 'recover', envId, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', (c) => {
        this.recovering.delete(envId);
        this.log(`recover ${envId}: exit ${c} ${out.slice(0, 200).replace(/\s+/g, ' ')}`);
        res();
      });
      p.on('error', () => {
        this.recovering.delete(envId);
        void recoverEnv(envId, prodDrivers, 'platform').finally(() => res());
      });
    });
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.devices.refresh();
      for (const t of listTasks().reverse()) {
        if (t.state === 'queued') moveTask(t.id, 'waiting-env', 'platform', 'scheduler');
        if (getTask(t.id)!.state !== 'waiting-env' || t.parent) continue;
        const env = getEnv(t.envId);
        if (!env || env.state !== 'ready' || this.recovering.has(env.id)) continue;
        // One task per phone (strictly serial on devices; legacy console tasks hold pool slots too).
        if (env.udid) {
          const dev = this.devices.get(env.udid);
          if (!dev || dev.status !== 'idle' || listEnvs().some((e) => e.udid === env.udid && e.id !== env.id && e.lease)) continue;
        }
        if (!leaseEnv(env.id, t.id)) continue;
        if (env.udid) this.devices.acquire(t.id, env.udid, env.surface);
        this.launch(t.id);
      }
      // Unfit environments are rechecked automatically (e.g. after the phone was unlocked), every 30 s.
      if (Date.now() - this.lastRecheck > 30_000) {
        this.lastRecheck = Date.now();
        for (const e of listEnvs()) if (e.state === 'unfit' && !this.recovering.has(e.id)) await onlineEnv(e.id, { drivers: prodDrivers, recover: (id) => this.recover(id) }, 'runtime', 'platform').catch((err) => this.log(`recheck ${e.id}: ${(err as Error).message}`));
      }
    } catch (e) {
      this.log(`tick: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private launch(id: string): void {
    const t = getTask(id)!;
    const log = createWriteStream(join(taskDir(id), 'task.log'));
    const child = spawn(process.execPath, [TSX, 'scripts/task-exec.ts', id], { env: { ...process.env, MIDSCENE_REPORT_QUIET: 'true' }, windowsHide: true });
    this.children.set(id, child.pid ?? 0);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    event(id, { type: 'note', note: `spawned pid ${child.pid}` });
    child.on('close', (code) => {
      log.end();
      this.children.delete(id);
      void this.ended(id, t.envId, code);
    });
  }

  /** The task process exited: close the record if it did not end itself, release, recover. */
  private async ended(id: string, envId: string, code: number | null): Promise<void> {
    const t = getTask(id)!;
    if (!isTerminal(t.state)) closeTask(id, t.cancelRequested ? 'cancel' : 'crash', 'platform', `task process exited (code ${code}) in ${t.state}`);
    const env = getEnv(envId);
    if (env?.udid) this.devices.release(env.udid, undefined, id);
    if (env?.lease?.taskId === id) {
      endLease(envId, id, { by: 'platform', basis: `task ${id} ended (${getTask(id)!.state})` });
      await this.recover(envId);
    }
    void this.tick();
  }

  private async watch(): Promise<void> {
    try {
      const fixes = await watchdogTick({ drivers: prodDrivers, recover: (id) => this.recover(id) });
      for (const f of fixes) this.log(`watchdog: task ${f.task} ${f.action} (${f.endedBy}) [${f.health}]`);
      await orphanSweep({ drivers: prodDrivers }, 'runtime');
    } catch (e) {
      this.log(`watchdog: ${(e as Error).message}`);
    }
  }

  async cancel(id: string, by: string): Promise<boolean> {
    const t = getTask(id);
    if (!t || isTerminal(t.state)) return false;
    if (t.state === 'queued' || t.state === 'waiting-env') {
      closeTask(id, 'cancel', by, 'cancelled before start');
      return true;
    }
    const { updateTask } = await import('./task');
    updateTask(id, (x) => void (x.cancelRequested = { at: new Date().toISOString(), by }));
    event(id, { type: 'note', note: `cancel requested by ${by}` });
    return true;
  }

  /** A person takes an environment offline (or the platform stops). */
  async offline(envId: string, by: string, endedBy: 'env-offline' | 'server-restart' = 'env-offline'): Promise<void> {
    const env = getEnv(envId)!;
    await offlineEnv(envId, { drivers: prodDrivers, recover: (id) => recoverEnv(id, prodDrivers, by).then(() => undefined), reachable: async () => (env.udid ? (await this.devices.refresh(), this.devices.get(env.udid)?.adbState === 'device') : true) }, by, endedBy);
  }

  async online(envId: string, by: string): Promise<void> {
    const e = getEnv(envId)!;
    if (e.state === 'offline') moveEnv(envId, 'checking', { by, basis: 'online requested' });
    await onlineEnv(envId, { drivers: prodDrivers, recover: (id) => this.recover(id) }, 'runtime', by);
  }

  /** Ctrl+C / SIGTERM: drain every environment that holds a lease, then stop. */
  async shutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const e of listEnvs()) if (e.lease) await this.offline(e.id, 'platform', 'server-restart').catch((err) => this.log(`drain ${e.id}: ${(err as Error).message}`));
  }
}
