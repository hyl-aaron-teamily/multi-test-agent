// Watchdog and cross-checks (W2-3 §3.4, §4.3 L3/L4, F6/F7). A task record must say what really happened:
// a live state needs a live process (pid + start time) with a fresh heartbeat; anything else is corrected
// here, with an audit record, and the environment it held is recovered.
import { bindLeaseProc, endLease, type EnvRecord, getEnv, listEnvs, moveEnv, setDirty } from './env';
import { alive, type ProcProbe, osProbe } from './proc';
import { type DriverFactory, recoverEnv, checkEnv } from './recover';
import type { Code } from './status';
import { type EndedBy, getTask, isTerminal, LIVE, listTasks, moveTask, readResult, type TaskRecord, type TaskState, updateTask } from './task';
import { audit } from './store';

export const HEARTBEAT_TIMEOUT_MS = Number(process.env.AUTOTEST_HEARTBEAT_TIMEOUT_MS ?? 30_000);
export const PROGRESS_GRACE_MS = 60_000;
export const DEFAULT_STEP_BUDGET_MS = 120_000;
export const DRAIN_WAIT_MS = Number(process.env.AUTOTEST_DRAIN_WAIT_MS ?? 60_000);

export type Health = 'ok' | 'no-process' | 'heartbeat-stale' | 'progress-stale' | 'over-limit';

/** Pure: how is a live-state task doing? */
export function judge(t: Pick<TaskRecord, 'state' | 'heartbeatAt' | 'progress' | 'startedAt' | 'createdAt' | 'options'>, now: number, procAlive: boolean, hardLimitMs?: number): Health {
  if (!LIVE.includes(t.state)) return 'ok';
  if (!procAlive) return 'no-process';
  const hb = Date.parse(t.heartbeatAt ?? t.startedAt ?? t.createdAt);
  if (now - hb > HEARTBEAT_TIMEOUT_MS) return 'heartbeat-stale';
  const pAt = Date.parse(t.progress.at ?? t.startedAt ?? t.createdAt);
  if (now - pAt > (t.progress.stepBudgetMs ?? DEFAULT_STEP_BUDGET_MS) + PROGRESS_GRACE_MS) return 'progress-stale';
  const limit = hardLimitMs ?? ((t.options.maxMinutes ?? 15) * 4 + 15) * 60_000;
  if (t.startedAt && now - Date.parse(t.startedAt) > limit) return 'over-limit';
  return 'ok';
}

const END: Record<EndedBy, { state: TaskState; code: Code }> = {
  normal: { state: 'done', code: 'OK' },
  cancel: { state: 'cancelled', code: 'CANCELLED' },
  timeout: { state: 'timed-out', code: 'TIMED_OUT' },
  stuck: { state: 'failed', code: 'TASK_STUCK' },
  crash: { state: 'interrupted', code: 'TASK_CRASHED' },
  'env-offline': { state: 'interrupted', code: 'INTERRUPTED' },
  'server-restart': { state: 'interrupted', code: 'INTERRUPTED' },
};

const TEXT: Record<EndedBy, string> = { normal: '正常结束', cancel: '已取消', timeout: '超出时长上限', stuck: '任务卡死，被看门狗终止', crash: '任务进程意外退出', 'env-offline': '环境下线导致中断', 'server-restart': '服务重启导致中断' };

/** Close a task that did not end by itself (or ended without a result): terminal state, code, how and where
 *  it stopped, partial results. A live-state task passes `recovering` first (§4.2). */
export function closeTask(id: string, endedBy: EndedBy, by: string, basis: string): TaskRecord {
  const t = getTask(id)!;
  if (isTerminal(t.state)) return t;
  const end = END[endedBy];
  if (t.state !== 'recovering' && LIVE.includes(t.state)) moveTask(id, 'recovering', by, basis);
  const r = readResult<{ runs?: { attempts?: { valid: number; hits: number } }[] }>(id);
  const valid = r?.runs?.reduce((n, x) => n + (x.attempts?.valid ?? 0), 0);
  const hits = r?.runs?.reduce((n, x) => n + (x.attempts?.hits ?? 0), 0);
  const from = getTask(id)!.state;
  const to: TaskState = from === 'queued' || from === 'waiting-env' ? (endedBy === 'cancel' ? 'cancelled' : 'interrupted') : end.state;
  const closed = moveTask(id, to, by, basis, (x) => {
    x.endedBy = endedBy;
    x.endedAt = { phase: x.progress.phase, round: x.progress.round, step: x.progress.step };
    x.outcome = { code: end.code, summary: `${TEXT[endedBy]}${x.progress.phase ? `（停在${phaseName(x)}）` : ''}` };
    if (valid !== undefined) x.partial = { valid, hits: hits ?? 0, note: '不完整，不给结论' };
  });
  // A series parent takes its unfinished children with it.
  for (const c of listTasks()) if (c.parent === id && !isTerminal(c.state)) closeTask(c.id, endedBy, by, `parent ${id}: ${basis}`);
  return closed;
}

const PH: Record<string, string> = { preflight: '预检', launch: '启动', prepare: '准备', warmup: '预热', loop: '循环', finishing: '收尾', recovery: '恢复' };
function phaseName(t: TaskRecord): string {
  const p = t.progress;
  return `${PH[p.phase ?? ''] ?? p.phase}${p.round !== undefined ? ` 第 ${p.round} 轮` : ''}${p.step !== undefined ? ` 第 ${p.step} 步` : ''}`;
}

export interface CrossDeps {
  drivers: DriverFactory;
  probe?: ProcProbe;
  now?: () => number;
  /** Recover in this process (tests) or in a separate `autotest env recover` process (platform). */
  recover?: (envId: string) => Promise<unknown>;
}

export interface Correction {
  task: string;
  env?: string;
  health: Health | 'no-lease';
  action: 'adopted' | 'closed';
  endedBy?: EndedBy;
}

/** One task found in a live state: adopt it, or end it as what really happened. */
async function correct(t: TaskRecord, d: CrossDeps, context: 'startup' | 'runtime', withLease: boolean): Promise<Correction> {
  const probe = d.probe ?? osProbe;
  const procAlive = alive(t.proc, probe);
  const h = judge(t, (d.now ?? Date.now)(), procAlive);
  if (h === 'ok' && withLease) {
    audit({ by: 'crosscheck', action: 'task.adopt', object: t.id, basis: `pid ${t.proc?.pid} alive, heartbeat ${t.heartbeatAt}` });
    return { task: t.id, env: t.envId, health: h, action: 'adopted' };
  }
  if (h === 'ok' && !withLease && procAlive) {
    // Live process without a lease: kill it (its environment is not held), then close.
    probe.kill(t.proc!.pid);
  }
  if (procAlive && h !== 'ok') probe.kill(t.proc!.pid);
  const endedBy: EndedBy = h === 'over-limit' ? 'timeout' : h === 'heartbeat-stale' || h === 'progress-stale' ? 'stuck' : context === 'startup' ? 'server-restart' : 'crash';
  closeTask(t.id, endedBy, 'crosscheck', `${withLease ? '' : 'no lease; '}${h}${t.proc ? ` (pid ${t.proc.pid})` : ''}`);
  return { task: t.id, env: t.envId, health: withLease ? h : 'no-lease', action: 'closed', endedBy };
}

/** Environment online (§3.4 上线): platform start, device back, or a person asked to recheck. */
export async function onlineEnv(envId: string, d: CrossDeps, context: 'startup' | 'runtime' = 'startup', by = 'crosscheck'): Promise<{ env: EnvRecord; corrections: Correction[] }> {
  const corrections: Correction[] = [];
  let env = getEnv(envId)!;
  if (env.lease) {
    const t = getTask(env.lease.taskId);
    if (t && (t.state === 'queued' || t.state === 'waiting-env')) {
      // Leased but never started (the platform stopped between lease and spawn): back to the queue.
      endLease(envId, t.id, { by, basis: `lease holder ${t.id} never started (${t.state}): requeued` });
      audit({ by, action: 'task.requeue', object: t.id, basis: 'lease released before start' });
      env = getEnv(envId)!;
    } else if (t && !isTerminal(t.state)) {
      const c = await correct(t, d, context, true);
      corrections.push(c);
      if (c.action === 'adopted') return { env, corrections };
    }
    if (env.lease) endLease(envId, env.lease.taskId, { by, basis: `lease holder ${env.lease.taskId} ${t ? (isTerminal(getTask(t.id)!.state) ? 'ended' : t.state) : 'missing'}` });
    env = getEnv(envId)!;
  }
  if (env.state === 'recovering' || env.state === 'draining') {
    await (d.recover ? d.recover(envId) : recoverEnv(envId, d.drivers, by));
  } else if (env.state !== 'quarantined' || by !== 'crosscheck') await checkEnv(envId, d.drivers, by);
  return { env: getEnv(envId)!, corrections };
}

/** Platform start (L4): every environment online, then every live-state task that holds no lease. */
export async function startupCrossCheck(d: CrossDeps): Promise<Correction[]> {
  const out: Correction[] = [];
  for (const e of listEnvs()) {
    if (e.state === 'offline' && !e.lease) {
      moveEnv(e.id, 'checking', { by: 'crosscheck', basis: 'platform start' });
    }
    out.push(...(await onlineEnv(e.id, d, 'startup')).corrections);
  }
  out.push(...(await orphanSweep(d, 'startup')));
  return out;
}

/** Live-state tasks that hold no lease (§3.4 step 2). */
export async function orphanSweep(d: CrossDeps, context: 'startup' | 'runtime'): Promise<Correction[]> {
  const out: Correction[] = [];
  for (const t of listTasks()) {
    if (!LIVE.includes(t.state) && t.state !== 'recovering') continue;
    const env = getEnv(t.envId);
    if (env?.lease?.taskId === t.id) continue;
    // Series children run inside their parent's process and lease: the parent's health covers them.
    if (t.parent && env?.lease?.taskId === t.parent) continue;
    if (t.state === 'recovering') {
      closeTask(t.id, context === 'startup' ? 'server-restart' : 'crash', 'crosscheck', 'recovering without a lease or process');
      out.push({ task: t.id, env: t.envId, health: 'no-lease', action: 'closed' });
      continue;
    }
    out.push(await correct(t, d, context, false));
  }
  return out;
}

/** Watchdog tick (runtime): stuck / dead / over-limit tasks are killed and closed; their environment is
 *  recovered. Returns the corrections. */
export async function watchdogTick(d: CrossDeps): Promise<Correction[]> {
  const out: Correction[] = [];
  for (const e of listEnvs()) {
    if (!e.lease) continue;
    const t = getTask(e.lease.taskId);
    if (!t || isTerminal(t.state) || !LIVE.includes(t.state)) continue;
    if (!t.proc) continue; // not registered yet: the spawner owns it
    const probe = d.probe ?? osProbe;
    const h = judge(t, (d.now ?? Date.now)(), alive(t.proc, probe));
    if (h === 'ok') continue;
    out.push(await correct(t, d, 'runtime', true));
    endLease(e.id, t.id, { by: 'watchdog', basis: `task ${t.id}: ${h}` });
    await (d.recover ? d.recover(e.id) : recoverEnv(e.id, d.drivers, 'watchdog'));
  }
  return out;
}

/** Environment offline (§3.4 下线): stop leasing, stop the task gracefully (≤ 60 s, then kill), recover if
 *  reachable (else mark dirty), close the task as interrupted (72), go offline clean | dirty. */
export async function offlineEnv(envId: string, d: CrossDeps & { reachable: () => Promise<boolean>; waitMs?: number }, by = 'platform', endedBy: EndedBy = 'env-offline'): Promise<EnvRecord> {
  const probe = d.probe ?? osProbe;
  let env = getEnv(envId)!;
  if (env.state === 'offline') return env;
  env = moveEnv(envId, 'draining', { by, basis: 'offline requested' });
  const lease = env.lease;
  if (lease) {
    const t = getTask(lease.taskId);
    if (t && !isTerminal(t.state)) {
      updateTask(t.id, (x) => void (x.cancelRequested = { at: new Date().toISOString(), by: `${by} (offline)` }));
      const deadline = (d.now ?? Date.now)() + (d.waitMs ?? DRAIN_WAIT_MS);
      while ((d.now ?? Date.now)() < deadline) {
        const x = getTask(t.id)!;
        if (isTerminal(x.state) || !alive(x.proc, probe)) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const x = getTask(t.id)!;
      if (!isTerminal(x.state) && alive(x.proc, probe)) probe.kill(x.proc!.pid);
      // Gracefully stopped tasks wrote their own terminal state (cancelled): an offline is still an interruption.
      if (!isTerminal(getTask(t.id)!.state)) closeTask(t.id, endedBy, by, 'environment offline');
      else if (getTask(t.id)!.state === 'cancelled' && getTask(t.id)!.endedBy === 'cancel') updateTask(t.id, (y) => void Object.assign(y, { state: 'interrupted', endedBy, outcome: { code: 'INTERRUPTED', summary: `${TEXT[endedBy]}（停在${phaseName(y)}）` } }));
    }
    endLease(envId, lease.taskId, { by, basis: 'offline' });
  }
  if (await d.reachable()) await (d.recover ? d.recover(envId) : recoverEnv(envId, d.drivers, by));
  else setDirty(envId, '下线时不可达', by);
  const after = getEnv(envId)!;
  const clean = !after.dirty && (after.baseline?.ok ?? false);
  return moveEnv(envId, 'offline', { by, basis: clean ? 'left clean' : 'left dirty' }, (e) => void (e.offlineAs = clean ? 'clean' : 'dirty'));
}

export { bindLeaseProc };
