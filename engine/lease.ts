// Lease + preflight, shared by both tiers: an account (and a phone slot for Android surfaces), then the
// preflight (W2-2 §4.2): an unfit phone is 环境不合格 — nothing is launched or tapped. Web surfaces: a browser
// starts and the account's signed-in session is valid.
import { sleep } from '../drivers/types';
import { TEAMILY_PACKAGE } from '../drivers/factory';
import type { AccountPool, Lease } from '../platform/accounts/account-pool';
import { type Env, onAndroid, onPlaywright, type Surface } from '../platform/accounts/types';
import type { DevicePool } from '../platform/device-pool';
import type { RunHooks } from '../platform/lifecycle/runtime';
import type { EnvSnapshot } from './failure';
import { ensureWebSession, type PlaywrightSurface } from './login/sessions';
import { envSnapshot, preflightAndroid, preflightWeb, type PreflightResult } from './preflight';
import { packageOf } from './session';

export interface LeaseOptions {
  pool: AccountPool;
  devices?: DevicePool;
  env: Env;
  surface: Surface;
  accountId?: string;
  udid?: string;
  taskId: string;
  preflight?: boolean;
  hooks?: Partial<RunHooks>;
  log: (s: string) => void;
}

export type Leased = { lease: Lease; account: Lease['accounts'][number]; udid?: string; preflight?: PreflightResult; error?: undefined } | { error: string; lease?: undefined };

/** Lease an account (+ endpoint slot), waiting up to 60 s. */
export async function leaseFor(o: LeaseOptions): Promise<Leased> {
  let lease: Lease | null = null;
  for (let i = 0; i < 30 && !lease; i++) {
    lease = o.pool.lease(o.taskId, { env: o.env, surface: o.surface, accountId: o.accountId, devices: o.devices, device: onAndroid(o.surface) ? o.udid : undefined });
    if (!lease) await sleep(2000);
  }
  if (!lease) return { error: `no free ${o.env} account${o.devices ? ' / endpoint slot' : ''} for ${o.surface}` };
  const account = lease.accounts[0];
  const udid = lease.device?.kind === 'android' ? lease.device.udid : (o.udid ?? (onAndroid(o.surface) ? account.boundDevice : undefined));
  return { lease, account, udid };
}

/** The preflight of a leased endpoint; undefined when switched off or nothing to check. */
export async function preflightFor(o: Pick<LeaseOptions, 'pool' | 'surface' | 'preflight' | 'hooks' | 'log'>, accountId: string, udid?: string): Promise<PreflightResult | undefined> {
  if (o.preflight === false || !((onAndroid(o.surface) && udid) || onPlaywright(o.surface))) return undefined;
  const t0 = Date.now();
  let pf: PreflightResult | undefined;
  // Ledger first (G6): the preflight may wake the screen and apply the environment's configuration items.
  if (udid && onAndroid(o.surface)) o.hooks?.effect?.({ kind: 'setting', target: 'preflight', value: 'wake / stayon / taplus / keyboard (environment configuration items)' });
  if (onPlaywright(o.surface)) {
    const w = await ensureWebSession(o.pool, accountId, o.surface as PlaywrightSurface).catch((e) => ({ ok: false, error: (e as Error).message.split('\n')[0], reused: false, file: '' }));
    pf = await preflightWeb({ sessionOk: w.ok, sessionDetail: w.ok ? `signed-in session ${w.reused ? 'valid (reused)' : 'renewed (logged in)'}` : `login failed: ${w.error}` });
  }
  if (udid && onAndroid(o.surface)) {
    const pkg = packageOf(o.surface) ?? TEAMILY_PACKAGE;
    // An adb failure inside the preflight is the environment (device gone / unauthorized), not the tool.
    pf = await preflightAndroid(udid, pkg, o.surface).catch(async (e) => {
      const snap = await envSnapshot(udid, pkg).catch(() => ({ online: false }) as EnvSnapshot);
      const msg = (e as Error).message.split('\n')[0];
      const id = snap.online === false ? 'online' : 'adb';
      return { ok: false, ms: 0, items: [{ id, ok: false, detail: msg }], changes: [], reason: `${id}: ${snap.online === false ? `设备不在线（${msg.slice(0, 120)}）` : msg}` } satisfies PreflightResult;
    });
  }
  pf!.ms = Date.now() - t0;
  o.log(`preflight: ${pf!.ok ? 'ok' : `NOT fit — ${pf!.reason}`} (${pf!.ms} ms${pf!.changes.length ? `; changed: ${pf!.changes.join('; ')}` : ''})`);
  return pf;
}
