// Credentials come only from a SecretBackend. Implementation 1: platform/accounts.local.yaml (gitignored).
// Swap for an OS keychain / Vault backend without touching callers.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { type Credentials, type Env, type EnvConfig, type Surface, SURFACES } from './types';

export interface AccountRecord {
  id: string;
  env: Env;
  email: string;
  tags: string[];
  surfaces: Surface[];
  boundDevice?: string;
}

export interface SecretBackend {
  accounts(): AccountRecord[];
  environments(): Record<Env, EnvConfig>;
  get(accountId: string): Credentials;
}

export const ACCOUNTS_FILE = resolve(process.env.ACCOUNTS_FILE ?? 'platform/accounts.local.yaml');

/** Pure: YAML text → env config + records (with password; only the backend keeps them). */
export function parseAccountsYaml(text: string): { envs: Record<Env, EnvConfig>; records: (AccountRecord & { password: string })[] } {
  const raw = (yaml.load(text) ?? {}) as Record<string, any>;
  const envs = {
    test: { webUrl: String(raw.environments?.test?.webUrl ?? 'https://chat-test.teamily.ai/chat') },
    prod: { webUrl: String(raw.environments?.prod?.webUrl ?? 'https://teamily.ai/chat') },
  };
  const records = (Array.isArray(raw.accounts) ? raw.accounts : [])
    .filter((a: any) => a?.id && (a.env === 'test' || a.env === 'prod') && a.email)
    .map((a: any) => ({
      id: String(a.id),
      env: a.env as Env,
      email: String(a.email),
      password: String(a.password ?? ''),
      tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
      surfaces: Array.isArray(a.surfaces) ? a.surfaces.filter((s: any) => SURFACES.includes(s)) : [...SURFACES],
      boundDevice: a.boundDevice ? String(a.boundDevice) : undefined,
    }));
  return { envs, records };
}

export class LocalYamlBackend implements SecretBackend {
  private envs: Record<Env, EnvConfig>;
  private records: (AccountRecord & { password: string })[];

  constructor(file = ACCOUNTS_FILE) {
    if (!existsSync(file)) throw new Error(`account backend missing: ${file} (gitignored local file, see milestone 5 §C.4)`);
    ({ envs: this.envs, records: this.records } = parseAccountsYaml(readFileSync(file, 'utf8')));
  }

  accounts(): AccountRecord[] {
    return this.records.map(({ password: _p, ...r }) => r);
  }

  environments(): Record<Env, EnvConfig> {
    return this.envs;
  }

  get(accountId: string): Credentials {
    const r = this.records.find((x) => x.id === accountId);
    if (!r || !r.password) throw new Error(`no credentials for account ${accountId}`);
    return { email: r.email, password: r.password };
  }
}
