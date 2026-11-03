// Milestone 5 CLI: Issue-driven black-box reproduction.
//   pnpm autotest accounts list|check [--env test|prod] [--force] [--id <acc>]
//   pnpm autotest nodes [--json]
//   pnpm autotest plan issues/<id>.md [--env prod] [--json]
//   pnpm autotest run --issue <id> [--env prod] [--approve <sub,...>] [--yes] [--max-steps N] [--max-minutes M] [--max-rounds N] [--headed]
//   pnpm autotest series --issue <id> --approve <sub>[:<surface>] --runs 10 [--max-rounds N]   (W2-2: N independent runs + summary)
//   pnpm autotest rerender <issue run dir>                                                    (old result.json → report.v2.md, W2-2 wording)
//   pnpm autotest replay <incident>/replay.json [--variant original|fast|slow|cold] [--times N]
//   pnpm autotest evidence review <incidentDir> | snapshot <incidentDir> --id <case> --expect .. | cases
import 'dotenv/config';
import { TEAMILY_PACKAGE } from '../drivers/factory';
import { openPools } from '../platform/pools';
import { patternById } from '../skills/teamily/patterns';
import { AccountPool } from '../platform/accounts/account-pool';
import type { Env } from '../platform/accounts/types';

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
    const { checkAccounts } = await import('../engine/login/health');
    const res = await checkAccounts(pool, { env, force: has(args, 'force'), ids: flag(args, 'id')?.split(',') });
    for (const r of res) console.log(`${r.id.padEnd(22)} ${r.env.padEnd(5)} ${r.result.ok ? (r.result.reused ? 'OK (session reused)' : 'OK (logged in, session cached)') : `FAIL ${r.result.error}`}`);
    const byEnv = (e: Env) => res.filter((r) => r.env === e && r.result.ok).length;
    console.log(`[accounts] ok: test ${byEnv('test')}, prod ${byEnv('prod')}`);
    return res.some((r) => r.result.ok) ? 0 : 1;
  }
  for (const a of pool.list(env)) console.log(`${a.id.padEnd(22)} ${a.env.padEnd(5)} ${a.status.padEnd(13)} device=${a.boundDevice ?? '-'}  lastLogin=${a.lastLogin ?? '-'} ${a.lastLoginOk === undefined ? '' : a.lastLoginOk ? 'ok' : `fail: ${a.lastError}`}`);
  return 0;
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
  replay: async (a) => (await import('../engine/recorder/replay')).replayCmd(a),
  evidence: async (a) => (await import('../engine/recorder/evidence-cases')).evidenceCmd(a),
};
if (!cmd || !table[cmd]) {
  console.error('Usage: m5 <accounts|nodes|plan|run|series|rerender|replay|evidence> ...');
  process.exit(2);
}
table[cmd](rest).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`[${cmd}] ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
