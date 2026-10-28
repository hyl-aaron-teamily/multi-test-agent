// Environment recovery (W2-3 §4.3 L3) and baseline check. Works from the environment's declaration and the
// last task's ledger only — never needs the task process (G6). Idempotent (G7): fix-walk then check-walk;
// repeating it, or cutting it short and repeating it, ends the same. A recovery that cannot reach the
// baseline quarantines the environment with its reason; it never retries in a loop (§11).
import { type AndroidBaselineDriver, type HostBaselineDriver, touchedConversations, type Walk, walkAndroid, walkWeb } from './baseline';
import { type EnvRecord, type EnvState, getEnv, moveEnv, updateEnv } from './env';
import { getTask, readLedger, updateTask } from './task';
import { audit } from './store';

export interface Drivers {
  android?: AndroidBaselineDriver;
  host: HostBaselineDriver;
}

export type DriverFactory = (env: EnvRecord) => Drivers;

export const RECOVERY_LIMIT_MS = Number(process.env.AUTOTEST_RECOVERY_MS ?? 180_000);

async function walk(env: EnvRecord, dr: Drivers, fix: boolean): Promise<Walk> {
  const ledger = env.lastTask ? readLedger(env.lastTask) : [];
  if (env.surface === 'android-app' && dr.android) return walkAndroid(dr.android, env, touchedConversations(ledger), fix, dr.host);
  return walkWeb(dr.host, fix);
}

function withLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`恢复超出时长上限 ${Math.round(ms / 1000)} s`)), ms).unref())]);
}

const SUGGEST = { locked: '在手机上输入 PIN 解锁，然后点「重新检查」', offline: '检查 USB 连接 / adb，然后点「重新检查」' };

export interface RecoverResult {
  env: EnvRecord;
  walk?: Walk;
  did: string[];
  error?: string;
}

/** Recover an environment (after a task, at drain, or when a check found it dirty). */
export async function recoverEnv(id: string, drivers: DriverFactory, by = 'recover'): Promise<RecoverResult> {
  let env = getEnv(id);
  if (!env) throw new Error(`no environment ${id}`);
  if (env.state === 'quarantined') return { env, did: [], error: '环境已隔离：需人工处理后点「重新检查」' };
  if (env.state === 'leased') return { env, did: [], error: `环境被任务 ${env.lease?.taskId} 占用：先结束任务` };
  const draining = env.state === 'draining';
  // ready / offline have no direct edge to recovering: they pass checking (§3.2).
  if (env.state === 'ready' || env.state === 'offline') env = moveEnv(id, 'checking', { by, basis: `recover requested from ${env.state}` });
  if (!draining && env.state !== 'recovering') env = moveEnv(id, 'recovering', { by, basis: `recover requested from ${env.state}` });
  const dr = drivers(env);
  const did: string[] = [];
  let w: Walk | undefined;
  let error: string | undefined;
  try {
    w = await withLimit(
      (async () => {
        const fixWalk = await walk(env!, dr, true);
        did.push(...fixWalk.did);
        if (fixWalk.blocker) return fixWalk;
        return walk(env!, dr, false);
      })(),
      RECOVERY_LIMIT_MS,
    );
  } catch (e) {
    error = (e as Error).message.split('\n')[0];
  }
  const at = new Date().toISOString();
  const failed = w?.items.filter((i) => !i.ok) ?? [];
  const reason = error ?? (failed.length ? failed.map((i) => i.detail).join('；') : undefined);
  const lastTask = env.lastTask;
  let to: EnvState;
  if (w?.ok && !error) to = 'ready';
  else if (w?.blocker) to = 'unfit';
  else to = 'quarantined';
  const patch = (e: EnvRecord) => {
    if (w) e.baseline = { at, ok: w.ok, items: w.items };
    if (to === 'ready') {
      e.dirty = undefined;
      e.lastTask = undefined;
    } else if (w?.blocker === 'offline' || error || to === 'quarantined') e.dirty = { reason: reason ?? 'recovery incomplete', at };
  };
  const out = draining ? updateEnv(id, patch) : moveEnv(id, to, { by, basis: w ? `baseline ${w.ok ? 'passed' : `failed: ${reason}`}` : `recovery error: ${error}`, reason, suggestion: w?.blocker ? SUGGEST[w.blocker] : to === 'quarantined' ? '查看基线未通过的项，人工处理后点「我已处理，重新检查」' : undefined }, patch);
  audit({ by, action: 'env.recover', object: id, after: draining ? `draining (${w?.ok ? 'clean' : 'dirty'})` : to, basis: did.join('；') || 'nothing to fix' });
  // The task that left the environment learns how it was left.
  if (lastTask && getTask(lastTask)) updateTask(lastTask, (t) => void (t.recovery = { result: to === 'ready' || (draining && w?.ok) ? 'recovered' : to === 'unfit' ? 'unfit' : 'quarantined', reason, at, steps: did }));
  return { env: out, walk: w, did, error };
}

/** Baseline check (look only). Pass → ready; a person is needed (locked / offline) → unfit; anything a fix
 *  can handle → recovery. From offline / unfit / ready / quarantined (a person asked) / checking. */
export async function checkEnv(id: string, drivers: DriverFactory, by = 'platform'): Promise<RecoverResult> {
  let env = getEnv(id);
  if (!env) throw new Error(`no environment ${id}`);
  if (env.state === 'leased' || env.state === 'recovering' || env.state === 'draining') return { env, did: [], error: `环境状态 ${env.state}：不检查` };
  if (env.state !== 'checking') env = moveEnv(id, 'checking', { by, basis: `check requested from ${env.state}` });
  if (env.dirty || env.lastTask) return recoverEnv(id, drivers, by);
  const w = await withLimit(walk(env, drivers(env), false), RECOVERY_LIMIT_MS).catch((e) => ({ items: [], did: [], ok: false, error: (e as Error).message }) as Walk & { error?: string });
  const at = new Date().toISOString();
  const failed = w.items.filter((i) => !i.ok);
  const reason = failed.map((i) => i.detail).join('；') || (w as { error?: string }).error;
  if (w.ok) return { env: moveEnv(id, 'ready', { by, basis: 'baseline passed' }, (e) => void (e.baseline = { at, ok: true, items: w.items })), walk: w, did: [] };
  if (w.blocker) return { env: moveEnv(id, 'unfit', { by, basis: `baseline: ${reason}`, reason, suggestion: SUGGEST[w.blocker] }, (e) => void (e.baseline = { at, ok: false, items: w.items })), walk: w, did: [] };
  return recoverEnv(id, drivers, by);
}
