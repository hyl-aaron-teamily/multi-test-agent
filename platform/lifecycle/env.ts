// Environment (W2-3 §3, F5): one execution endpoint a task uses exclusively — a phone surface or a host
// browser, for one service env. Own state machine, persisted record (platform/state/envs/<id>.json, atomic),
// one lease at a time (lock + atomic write), audit of every transition.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcId } from './proc';
import { audit, readJson, stateRoot, withLock, writeJsonAtomic } from './store';

export type EnvState = 'offline' | 'checking' | 'ready' | 'leased' | 'recovering' | 'unfit' | 'quarantined' | 'draining';
export type EnvSurface = 'android-app' | 'android-web' | 'desktop-web' | 'mobile-web';

/** A system change the environment needs to be testable (e.g. Taplus blacklist): declared once, consented
 *  once at registration, then applied by every preflight without per-plan approval (§3.1). */
export interface ConfigItem {
  id: string;
  what: string;
  why: string;
  restore: string;
  consentedBy?: string;
  consentedAt?: string;
}

export interface BaselineItem {
  id: string;
  ok: boolean;
  detail: string;
  /** Can the recovery fix it without a person (锁屏: no). */
  auto: boolean;
}

export interface EnvLease {
  taskId: string;
  /** The task process (pid + start time); absent until the process registered itself. */
  proc?: ProcId;
  at: string;
}

export interface EnvRecord {
  schemaVersion: 1;
  id: string;
  surface: EnvSurface;
  serviceEnv: 'test' | 'prod';
  /** adb serial (phones) / browser name (hosts). */
  device: string;
  udid?: string;
  package?: string;
  appVersion?: string;
  account?: string;
  profile?: { name: string; hash?: string };
  state: EnvState;
  stateSince: string;
  /** Why it is unfit / quarantined, and what a person should do. */
  reason?: string;
  suggestion?: string;
  configItems: ConfigItem[];
  lease?: EnvLease;
  /** The task that held the last lease: its ledger tells the recovery what was touched. Cleared on ready. */
  lastTask?: string;
  /** Declared default input method (baseline: the keyboard is this one). */
  ime?: string;
  dirty?: { reason: string; at: string };
  baseline?: { at: string; ok: boolean; items: BaselineItem[] };
  /** Last time it went offline: did it leave clean? */
  offlineAs?: 'clean' | 'dirty';
  updatedAt: string;
}

/** Allowed transitions (§3.2). 'draining' is reachable from every state. */
export const ENV_FLOW: Record<EnvState, EnvState[]> = {
  offline: ['checking'],
  checking: ['ready', 'unfit', 'quarantined', 'recovering', 'offline'],
  ready: ['leased', 'checking', 'unfit', 'offline'],
  leased: ['recovering', 'unfit'],
  recovering: ['ready', 'quarantined', 'unfit'],
  unfit: ['checking', 'recovering', 'offline'],
  quarantined: ['checking'],
  draining: ['offline'],
};

export function canMove(from: EnvState, to: EnvState): boolean {
  return to === 'draining' ? from !== 'draining' && from !== 'offline' : ENV_FLOW[from].includes(to);
}

export class TransitionError extends Error {}

export const envFile = (id: string) => join(stateRoot(), 'envs', `${id.replace(/[^\w.@-]/g, '_')}.json`);

export function getEnv(id: string): EnvRecord | undefined {
  return readJson<EnvRecord>(envFile(id));
}

export function listEnvs(): EnvRecord[] {
  const dir = join(stateRoot(), 'envs');
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((f) => readJson<EnvRecord>(join(dir, f))!).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

/** Read-modify-write under the environment's lock. */
export function updateEnv(id: string, fn: (e: EnvRecord) => EnvRecord | void): EnvRecord {
  return withLock(`env-${id}`, () => {
    const e = getEnv(id);
    if (!e) throw new TransitionError(`no environment ${id}`);
    const next = (fn(e) ?? e) as EnvRecord;
    next.updatedAt = new Date().toISOString();
    writeJsonAtomic(envFile(id), next);
    return next;
  });
}

/** Register or refresh an environment's declaration (state untouched for an existing one). */
export function registerEnv(decl: Omit<EnvRecord, 'schemaVersion' | 'state' | 'stateSince' | 'updatedAt' | 'configItems'> & { configItems?: ConfigItem[] }): EnvRecord {
  return withLock(`env-${decl.id}`, () => {
    const now = new Date().toISOString();
    const prev = getEnv(decl.id);
    // Consent survives re-registration as long as the item text is unchanged.
    const items = (decl.configItems ?? []).map((c) => {
      const p = prev?.configItems.find((x) => x.id === c.id && x.what === c.what && x.restore === c.restore);
      return p?.consentedAt ? { ...c, consentedBy: p.consentedBy, consentedAt: p.consentedAt } : c;
    });
    const e: EnvRecord = prev ? { ...prev, ...decl, configItems: items, updatedAt: now } : { schemaVersion: 1, ...decl, configItems: items, state: 'offline', stateSince: now, updatedAt: now };
    writeJsonAtomic(envFile(decl.id), e);
    if (!prev) audit({ by: 'platform', action: 'env.register', object: decl.id, after: 'offline' });
    return e;
  });
}

export interface MoveOpts {
  by: string;
  basis: string;
  reason?: string;
  suggestion?: string;
}

/** One state transition; illegal ones throw. Every transition is audited. */
export function moveEnv(id: string, to: EnvState, o: MoveOpts, patch?: (e: EnvRecord) => void): EnvRecord {
  let before: EnvState | undefined;
  const e = updateEnv(id, (e) => {
    before = e.state;
    if (e.state !== to && !canMove(e.state, to)) throw new TransitionError(`env ${id}: ${e.state} → ${to} not allowed`);
    // quarantined → checking only by a person (§3.2).
    if (e.state === 'quarantined' && to === 'checking' && ['platform', 'crosscheck', 'recover', 'watchdog', 'policy'].includes(o.by)) throw new TransitionError(`env ${id}: leaving quarantine needs a person`);
    e.state = to;
    e.stateSince = new Date().toISOString();
    e.reason = to === 'ready' || to === 'leased' ? undefined : (o.reason ?? e.reason);
    e.suggestion = to === 'ready' || to === 'leased' ? undefined : (o.suggestion ?? e.suggestion);
    patch?.(e);
  });
  audit({ by: o.by, action: 'env.move', object: id, before, after: to, basis: o.basis });
  return e;
}

/** Take the environment for a task: only from `ready`, only one lease. Returns false when not leasable. */
export function leaseEnv(id: string, taskId: string, by = 'platform'): boolean {
  try {
    let ok = false;
    updateEnv(id, (e) => {
      if (e.state !== 'ready' || e.lease) return;
      e.state = 'leased';
      e.stateSince = new Date().toISOString();
      e.lease = { taskId, at: e.stateSince };
      ok = true;
    });
    if (ok) audit({ by, action: 'env.lease', object: id, before: 'ready', after: 'leased', basis: `task ${taskId}` });
    return ok;
  } catch {
    return false;
  }
}

/** The task process records itself in the lease (pid + start time). */
export function bindLeaseProc(id: string, taskId: string, proc: ProcId): void {
  updateEnv(id, (e) => {
    if (e.lease?.taskId === taskId) e.lease.proc = proc;
  });
}

/** Lease ends: the environment goes to `recovering` (the recovery decides ready / quarantined). */
export function endLease(id: string, taskId: string, o: MoveOpts): EnvRecord | undefined {
  const e = getEnv(id);
  if (!e || e.lease?.taskId !== taskId) return e;
  const to: EnvState = e.state === 'draining' ? 'draining' : 'recovering';
  return moveEnv(id, to, o, (x) => {
    x.lease = undefined;
    x.lastTask = taskId;
  });
}

export function setDirty(id: string, reason: string, by: string): void {
  updateEnv(id, (e) => {
    e.dirty = { reason, at: new Date().toISOString() };
  });
  audit({ by, action: 'env.dirty', object: id, after: reason });
}

export function consentConfig(id: string, itemId: string, by: string): EnvRecord {
  const e = updateEnv(id, (e) => {
    const c = e.configItems.find((x) => x.id === itemId);
    if (!c) throw new TransitionError(`env ${id}: no config item ${itemId}`);
    c.consentedBy = by;
    c.consentedAt = new Date().toISOString();
  });
  audit({ by, action: 'env.consent', object: `${id}#${itemId}` });
  return e;
}

/** Pure: config items still waiting for the one-time consent. */
export const unconsented = (e: EnvRecord) => e.configItems.filter((c) => !c.consentedAt);
