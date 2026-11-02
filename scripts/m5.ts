// Milestone 5 CLI: Issue-driven black-box reproduction.
//   pnpm autotest accounts list|check [--env test|prod] [--force] [--id <acc>]
//   pnpm autotest nodes [--json]
//   pnpm autotest plan issues/<id>.md [--env prod] [--json]
//   pnpm autotest run --issue <id> [--env prod] [--approve <sub,...>] [--yes] [--max-steps N] [--max-minutes M] [--max-rounds N] [--headed]
//   pnpm autotest series --issue <id> --approve <sub>[:<surface>] --runs 10 [--max-rounds N]   (W2-2: N independent runs + summary)
//   pnpm autotest rerender <issue run dir>                                                    (old result.json → report.v2.md, W2-2 wording)
//   pnpm autotest replay <incident>/replay.json [--variant original|fast|slow|cold] [--times N]
//   pnpm autotest evidence review <incidentDir> | snapshot <incidentDir> --id <case> --expect .. | cases
//   pnpm autotest sync [--roles desktop-web,android-web,android-app] [--rounds N] [--env prod] [--timeout S]
import 'dotenv/config';
import { TEAMILY_PACKAGE } from '../drivers/factory';
import { openPools } from '../platform/pools';
import { patternById } from '../skills/teamily/patterns';
import { AccountPool } from '../platform/accounts/account-pool';
import type { Env, Surface } from '../platform/accounts/types';

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
export const has = (args: string[], name: string) => args.includes(`--${name}`);

async function accounts(args: string[]): Promise<number> {
  const pool = new AccountPool();
  await pool.reload();
  const env = flag(args, 'env') as Env | undefined;
  if (args[0] === 'check') {
    const { checkAccounts } = await import('../executor/login/health');
    const res = await checkAccounts(pool, { env, force: has(args, 'force'), ids: flag(args, 'id')?.split(',') });
    for (const r of res) console.log(`${r.id.padEnd(22)} ${r.env.padEnd(5)} ${r.result.ok ? (r.result.reused ? 'OK (session reused)' : 'OK (logged in, session cached)') : `FAIL ${r.result.error}`}`);
    const byEnv = (e: Env) => res.filter((r) => r.env === e && r.result.ok).length;
    console.log(`[accounts] ok: test ${byEnv('test')}, prod ${byEnv('prod')}`);
    return res.some((r) => r.result.ok) ? 0 : 1;
  }
  for (const a of pool.list(env)) console.log(`${a.id.padEnd(22)} ${a.env.padEnd(5)} ${a.status.padEnd(13)} device=${a.boundDevice ?? '-'}  lastLogin=${a.lastLogin ?? '-'} ${a.lastLoginOk === undefined ? '' : a.lastLoginOk ? 'ok' : `fail: ${a.lastError}`}`);
  return 0;
}

/** T2 smoke: by coordinates only, open a conversation (picked at preparation) and send one message. */
async function sync(args: string[]): Promise<number> {
  const { runSync } = await import('../executor/sync');
  const { resolve } = await import('node:path');
  const env = (flag(args, 'env') ?? 'prod') as Env;
  const { pool, devices } = await openPools();
  // --roles desktop-web,android-web,android-app  (a role per surface; repeat a surface with a suffix: desktop-web#2)
  const roles = (flag(args, 'roles') ?? 'desktop-web,android-web,android-app').split(',').map((x) => {
    const [surface] = x.split('#');
    return { id: x.replace('#', '-'), surface: surface as Surface, device: flag(args, `device-${surface}`) };
  });
  const runDir = resolve('midscene_run/sync', new Date().toISOString().replace(/[:.]/g, '-'));
  const r = await runSync({ env, roles, rounds: flag(args, 'rounds') ? Number(flag(args, 'rounds')) : undefined, conversation: flag(args, 'conversation'), timeoutSec: flag(args, 'timeout') ? Number(flag(args, 'timeout')) : undefined, settleSec: flag(args, 'settle') ? Number(flag(args, 'settle')) : undefined, runDir, pool, devices, headed: has(args, 'headed') });
  console.log(`[sync] ${r.conclusion} — ${r.detail}`);
  console.log(`[sync] report → ${resolve(runDir, 'report.md')}`);
  return r.conclusion === '全部同步' ? 0 : 1;
}

async function nodes(args: string[]): Promise<number> {
  const { listNodes } = await import('../skills/teamily/nodes');
  const list = listNodes();
  if (has(args, 'json')) console.log(JSON.stringify(list, null, 2));
  else for (const n of list) console.log(`${n.name.padEnd(28)} ${n.description}\n${' '.repeat(28)} input: ${JSON.stringify((n.input as any).properties ?? {})}`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const table: Record<string, (a: string[]) => Promise<number>> = {
  accounts,
  nodes,
  plan: async (a) => (await import('./issue-cli')).planCmd(a),
  run: async (a) => (await import('./issue-cli')).runCmd(a),
  series: async (a) => (await import('./issue-cli')).seriesCmd(a),
  rerender: async (a) => (await import('./issue-cli')).rerenderCmd(a),
  replay: async (a) => (await import('../executor/replay')).replayCmd(a),
  evidence: async (a) => (await import('../incident/evidence-cases')).evidenceCmd(a),
  sync,
};
if (!cmd || !table[cmd]) {
  console.error('Usage: m5 <accounts|nodes|plan|run|series|rerender|replay|evidence|sync> ...');
  process.exit(2);
}
table[cmd](rest).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`[${cmd}] ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
