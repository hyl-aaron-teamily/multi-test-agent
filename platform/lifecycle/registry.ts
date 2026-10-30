// Environment registry: platform/devices.yaml (phones × surfaces, this computer's browsers) × the account
// pool's service envs → environment declarations (§3.1). Also the production driver factory.
import { existsSync, readFileSync } from 'node:fs';
import { BROWSER_PACKAGE, profileKey, TEAMILY_PACKAGE } from '../../drivers/factory';
import { sessionFile } from '../../executor/login/sessions';
import { sha } from '../../issue/drafts';
import { profilePath } from '../../skills/profile';
import type { AccountPool } from '../accounts/account-pool';
import type { PoolConfig } from '../device-pool';
import { adbBaselineDriver, androidConfigItems, hostDriver } from './android-ops';
import { type EnvRecord, type EnvSurface, registerEnv } from './env';
import type { DriverFactory } from './recover';
import { getTask } from './task';

export interface EnvDecl {
  id: string;
  surface: EnvSurface;
  serviceEnv: 'test' | 'prod';
  device: string;
  udid?: string;
  package?: string;
  account?: string;
}

export const envIdOf = (surface: string, device: string, serviceEnv: string) => `${surface}:${device}@${serviceEnv}`;

/** Pure: declarations from the pool config and the accounts (one per signed-in phone surface; host browsers
 *  per service env that has an account). */
export function declareEnvs(cfg: PoolConfig, accounts: { id: string; env: 'test' | 'prod' }[]): EnvDecl[] {
  const out: EnvDecl[] = [];
  for (const d of cfg.devices) {
    for (const surface of Object.keys(d.capacity) as EnvSurface[]) {
      const acc = d.accounts[surface];
      const env = accounts.find((a) => a.id === acc)?.env;
      if (!acc || !env) continue;
      // android-web: the app under test on the phone is its browser (preflight, recovery and versions use it).
      out.push({ id: envIdOf(surface, d.udid, env), surface, serviceEnv: env, device: d.udid, udid: d.udid, package: surface === 'android-app' ? TEAMILY_PACKAGE : surface === 'android-web' ? BROWSER_PACKAGE : undefined, account: acc });
    }
  }
  const envs = [...new Set(accounts.map((a) => a.env))];
  for (const h of cfg.hosts) {
    for (const surface of Object.keys(h.capacity) as EnvSurface[]) {
      if (surface !== 'desktop-web' && surface !== 'mobile-web') continue;
      for (const env of envs) out.push({ id: envIdOf(surface, surface === 'desktop-web' ? 'edge' : 'chromium', env), surface, serviceEnv: env, device: surface === 'desktop-web' ? 'edge' : 'chromium' });
    }
  }
  return out;
}

export function syncEnvs(cfg: PoolConfig, pool: AccountPool): EnvRecord[] {
  const accounts = pool.list().map((a) => ({ id: a.id, env: a.env }));
  return declareEnvs(cfg, accounts).map((d) => {
    const pf = profilePath(profileKey(d.surface, d.serviceEnv, d.udid));
    // Both phone surfaces: the preflight writes the same items (Taplus for the app under test, stay-on).
    return registerEnv({ ...d, profile: { name: profileKey(d.surface, d.serviceEnv, d.udid), hash: existsSync(pf) ? sha(readFileSync(pf, 'utf8')) : undefined }, configItems: (d.surface === 'android-app' || d.surface === 'android-web') && d.package ? androidConfigItems(d.package) : [] });
  });
}

/** Production drivers: adb for the phone, the last task's process for the host, session file for web. */
export const prodDrivers: DriverFactory = (env) => {
  const proc = env.lastTask ? getTask(env.lastTask)?.proc : env.lease ? getTask(env.lease.taskId)?.proc : undefined;
  const web = env.surface === 'desktop-web' || env.surface === 'mobile-web';
  const sessionOk = web
    ? async () => {
        // Any pool account of this service env with a session file that parses with cookies.
        const { AccountPool } = await import('../accounts/account-pool');
        const pool = new AccountPool();
        await pool.reload();
        const accs = pool.list(env.serviceEnv);
        for (const a of accs) {
          const f = sessionFile(a.id);
          if (!existsSync(f)) continue;
          try {
            const j = JSON.parse(readFileSync(f, 'utf8')) as { cookies?: unknown[] };
            if (Array.isArray(j.cookies) && j.cookies.length) return { ok: true, detail: `登录态文件有效（${a.id}）` };
          } catch {
            /* torn */
          }
        }
        return { ok: false, detail: `没有可用的 ${env.serviceEnv} 登录态文件（运行 autotest accounts check --env ${env.serviceEnv}）` };
      }
    : undefined;
  const phone = (env.surface === 'android-app' || env.surface === 'android-web') && env.udid;
  return { android: phone ? adbBaselineDriver(env.udid!, env.package ?? (env.surface === 'android-web' ? BROWSER_PACKAGE : TEAMILY_PACKAGE)) : undefined, host: hostDriver(proc, sessionOk) };
};
