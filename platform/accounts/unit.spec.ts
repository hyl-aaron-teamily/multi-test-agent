import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountPool } from './account-pool';
import { parseAccountsYaml, type SecretBackend } from './secret-backend';

const YAML = `environments:
  test: { webUrl: https://t.example/chat }
  prod: { webUrl: https://p.example/chat }
accounts:
  - { id: t1, env: test, email: a@x, password: s1 }
  - { id: p1, env: prod, email: a@x, password: s2 }
  - { id: p2, env: prod, email: b@x, password: s3, surfaces: [desktop-web] }
`;

function backend(): SecretBackend {
  const { envs, records } = parseAccountsYaml(YAML);
  return {
    accounts: () => records.map(({ password: _p, ...r }) => r),
    environments: () => envs,
    get: (id) => {
      const r = records.find((x) => x.id === id)!;
      return { email: r.email, password: r.password };
    },
  };
}

describe('account pool', () => {
  it('parses records, keeps the same email in two envs as two accounts', () => {
    const { records } = parseAccountsYaml(YAML);
    expect(records.map((r) => `${r.id}:${r.env}`)).toEqual(['t1:test', 'p1:prod', 'p2:prod']);
    expect(records[2].surfaces).toEqual(['desktop-web']);
  });
  it('state never contains passwords', async () => {
    const pool = new AccountPool(backend(), join(mkdtempSync(join(tmpdir(), 'acc-')), 'a.json'));
    const list = await pool.reload();
    expect(JSON.stringify(list)).not.toMatch(/s1|s2|s3/);
  });
  it('leases by env + surface, busy until released, then cools down', async () => {
    const pool = new AccountPool(backend(), join(mkdtempSync(join(tmpdir(), 'acc-')), 'a.json'));
    await pool.reload();
    const l = pool.lease('task1', { env: 'prod', surface: 'mobile-web' });
    expect(l?.accounts.map((a) => a.id)).toEqual(['p1']);
    expect(pool.lease('task2', { env: 'prod', surface: 'mobile-web' })).toBeNull();
    pool.release(l!);
    expect(pool.get('p1')?.status).toBe('idle');
    expect(pool.pick({ env: 'prod', surface: 'mobile-web' })).toEqual([]);
    expect(pool.pick({ env: 'prod', surface: 'mobile-web' }, Date.now() + 60_000).map((a) => a.id)).toEqual(['p1']);
  });
  it('count > free → nothing', async () => {
    const pool = new AccountPool(backend(), join(mkdtempSync(join(tmpdir(), 'acc-')), 'a.json'));
    await pool.reload();
    expect(pool.pick({ env: 'test', surface: 'desktop-web', count: 2 })).toEqual([]);
  });
});
