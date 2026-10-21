// Health check: one cursor login per account (or session reuse), result recorded as lastLoginOk / lastError.
import type { AccountPool } from './account-pool';
import { ensureWebSession, type SessionResult } from './sessions';
import type { Env } from './types';

export async function checkAccounts(pool: AccountPool, opts: { env?: Env; force?: boolean; ids?: string[] } = {}): Promise<{ id: string; env: Env; result: SessionResult }[]> {
  const out: { id: string; env: Env; result: SessionResult }[] = [];
  for (const a of pool.list(opts.env)) {
    if (opts.ids?.length && !opts.ids.includes(a.id)) continue;
    if (a.status === 'disabled') continue;
    out.push({ id: a.id, env: a.env, result: await ensureWebSession(pool, a.id, 'desktop-web', opts.force) });
  }
  return out;
}
