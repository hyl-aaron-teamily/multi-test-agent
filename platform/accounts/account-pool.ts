// Account pool, same shape as DevicePool: reload / lease / release.
// State (no secrets) → platform/state/accounts.json. Accounts are isolated by env: the same email in
// test and prod is two accounts. lease() takes an endpoint slot (phone / this computer) together with the account.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DevicePool, PoolDevice } from '../device-pool';
import { LocalYamlBackend, type SecretBackend } from './secret-backend';
import type { Account, Env, Surface } from './types';

export const ACCOUNTS_STATE = resolve('platform/state/accounts.json');
const COOLDOWN_MS = 30_000;

export interface LeaseRequest {
  env: Env;
  surface: Surface;
  count?: number;
  accountId?: string;
  /** Also lease a slot (endpoint × surface) from this pool: phones for Android surfaces, this computer otherwise. */
  devices?: DevicePool;
  /** Pin the endpoint (adb serial or host:<id>). */
  device?: string;
}

export interface Lease {
  accounts: Account[];
  device?: PoolDevice;
  surface?: Surface;
  taskId?: string;
}

export class AccountPool {
  private accounts = new Map<string, Account>();

  constructor(
    readonly backend: SecretBackend = new LocalYamlBackend(),
    private stateFile = ACCOUNTS_STATE,
  ) {}

  /** Merge backend records with persisted runtime state. */
  async reload(): Promise<Account[]> {
    const prev: Account[] = existsSync(this.stateFile) ? (JSON.parse(await readFile(this.stateFile, 'utf8')).accounts ?? []) : [];
    this.accounts.clear();
    for (const r of this.backend.accounts()) {
      const p = prev.find((x) => x.id === r.id);
      this.accounts.set(r.id, {
        ...r,
        boundDevice: r.boundDevice ?? p?.boundDevice,
        status: p?.status === 'disabled' || p?.status === 'login-failed' ? p.status : 'idle',
        lastLogin: p?.lastLogin,
        lastLoginOk: p?.lastLoginOk,
        lastError: p?.lastError,
      });
    }
    await this.persist();
    return this.list();
  }

  list(env?: Env): Account[] {
    return [...this.accounts.values()].filter((a) => !env || a.env === env);
  }

  get(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  webUrl(env: Env): string {
    return this.backend.environments()[env].webUrl;
  }

  /** Free accounts satisfying the request ([] if fewer than `count`). Accounts that logged in fine go first. */
  pick(req: LeaseRequest, now = Date.now()): Account[] {
    const n = req.count ?? 1;
    const free = this.list(req.env).filter(
      (a) =>
        (a.status === 'idle' || (req.accountId === a.id && a.status === 'login-failed')) &&
        a.surfaces.includes(req.surface) &&
        (!a.cooldownUntil || Date.parse(a.cooldownUntil) <= now) &&
        (!req.accountId || a.id === req.accountId),
    );
    free.sort((a, b) => Number(b.lastLoginOk ?? false) - Number(a.lastLoginOk ?? false));
    return free.length >= n ? free.slice(0, n) : [];
  }

  /** Lease accounts (and a slot of an endpoint) in one step. null if not satisfiable now.
   *  On a phone the account is the one signed in there (devices.yaml `accounts`), never another. */
  lease(taskId: string, req: LeaseRequest): Lease | null {
    let device: PoolDevice | undefined;
    let accountId = req.accountId;
    if (req.devices) {
      const d = req.devices.acquire(taskId, req.device, req.surface);
      if (!d) return null;
      const signed = d.accounts[req.surface];
      if (signed && accountId && signed !== accountId) {
        req.devices.release(d.udid, req.surface, taskId);
        return null;
      }
      accountId = accountId ?? signed;
      device = d;
    }
    const accounts = this.pick({ ...req, accountId });
    if (!accounts.length) {
      if (device) req.devices!.release(device.udid, req.surface, taskId);
      return null;
    }
    for (const a of accounts) Object.assign(a, { status: 'busy', taskId, boundDevice: device?.kind === 'android' ? device.udid : a.boundDevice });
    void this.persist();
    return { accounts, device, surface: req.surface, taskId };
  }

  release(lease: Lease, devices?: DevicePool): void {
    for (const a of lease.accounts) {
      const cur = this.accounts.get(a.id);
      if (cur?.status === 'busy') Object.assign(cur, { status: 'idle', taskId: undefined, cooldownUntil: new Date(Date.now() + COOLDOWN_MS).toISOString() });
    }
    if (lease.device && devices) devices.release(lease.device.udid, lease.surface, lease.taskId);
    void this.persist();
  }

  async markLogin(id: string, ok: boolean, error?: string): Promise<void> {
    const a = this.accounts.get(id);
    if (!a) return;
    Object.assign(a, { lastLogin: new Date().toISOString(), lastLoginOk: ok, lastError: ok ? undefined : error?.slice(0, 200) });
    if (!ok && a.status === 'idle') a.status = 'login-failed';
    if (ok && a.status === 'login-failed') a.status = 'idle';
    await this.persist();
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify({ updatedAt: new Date().toISOString(), accounts: this.list() }, null, 2));
  }
}
