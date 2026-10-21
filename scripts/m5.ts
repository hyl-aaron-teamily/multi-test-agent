// Milestone 5 CLI: Issue-driven black-box reproduction.
//   pnpm autotest accounts list|check [--env test|prod] [--force] [--id <acc>]
//   pnpm autotest skill calibrate --surface desktop-web|mobile-web|android-app --env test|prod [--device <udid>] [--account <id>] [--headed]
//   pnpm autotest nodes [--json]
//   pnpm autotest plan issues/<id>.md [--env prod] [--json]
//   pnpm autotest run --issue <id> [--env prod] [--approve <sub,...>] [--yes] [--max-steps N] [--max-minutes M] [--headed]
//   pnpm autotest replay <incident>/replay.json [--variant original|fast|slow|cold] [--times N]
import 'dotenv/config';
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
    const { checkAccounts } = await import('../platform/accounts/health');
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
async function smoke(args: string[]): Promise<number> {
  const surface = (flag(args, 'surface') ?? 'desktop-web') as Surface;
  const env = (flag(args, 'env') ?? 'prod') as Env;
  const { runPlan, runDirFor } = await import('../executor/run');
  const { DevicePool } = await import('../platform/device-pool');
  const { SKILL_VERSION } = await import('../skills/teamily/vocab');
  const pool = new AccountPool();
  await pool.reload();
  const devices = new DevicePool();
  await devices.reloadConfig();
  await devices.refresh();
  const id = `smoke-${surface}-${env}`;
  // --crash-after S (android): loop open/back and inject `am crash` after S seconds (flight-recorder check).
  const crashAfter = flag(args, 'crash-after') ? Number(flag(args, 'crash-after')) : undefined;
  if (crashAfter && surface === 'android-app') {
    const { adb } = await import('../core/adb');
    const udid = flag(args, 'device') ?? (await devices.refresh()).find((x) => x.status === 'idle')?.udid;
    setTimeout(() => {
      console.log(`[smoke] injecting: am crash ai.teamily.mobile`);
      void adb(['shell', 'am', 'crash', 'ai.teamily.mobile'], udid).catch((e) => console.error(e.message));
    }, crashAfter * 1000);
  }
  const loopActions = [
    { type: 'node' as const, node: { name: 'teamily.openConversation', input: { target: 'conv' } }, delayAfterMs: 900 },
    { type: 'back' as const, delayAfterMs: 900 },
  ];
  const r = await runPlan({
    plan: {
      id,
      issueRef: 'smoke',
      title: '打开会话 → 发送一条消息（坐标驱动）',
      category: 'bug-intermittent',
      surface,
      issueSurfaces: [],
      env,
      launch: 'once',
      targets: [{ id: 'conv', kind: 'other-conversation', guidance: "the user's own Personal AI conversation (sending there disturbs no one)" }],
      setup: crashAfter ? [] : [{ type: 'node', node: { name: 'teamily.openConversation', input: { target: 'conv' } }, delayAfterMs: 1000 }],
      actions: crashAfter ? loopActions : [{ type: 'node', node: { name: 'teamily.sendMessage', input: { text: `autotest smoke ${new Date().toISOString().slice(11, 19)}` } }, delayAfterMs: 1000 }],
      checks: crashAfter ? [{ kind: 'crash', expect: 'no crash', want: 'absent' }] : [{ kind: 'visual-region', page: 'chat', region: 'composer', expect: '发送后输入框恢复为空', want: 'present' }],
      prepare: [],
      afterCheck: [],
      limits: { maxSteps: crashAfter ? 400 : 1, maxMinutes: 10, maxIntervalMs: 1000 },
      verdictRule: { anyHit: true },
      provenance: { generatedBy: 'manual', skillVersion: SKILL_VERSION },
    },
    runDir: runDirFor(id),
    pool,
    devices,
    udid: flag(args, 'device'),
    headed: has(args, 'headed'),
  });
  if (crashAfter) {
    console.log(`[smoke] crash run: ${r.conclusion} — ${r.conclusionDetail}; incidents: ${r.incidents.join(', ') || 'none'}`);
    return r.incidents.length ? 0 : 1;
  }
  const sent = r.roundLog[0]?.results[0];
  console.log(`[smoke] ${surface}@${env}: target ${r.targets.map((t) => `"${t.chosen}"`).join(', ')}; steps ${r.stats.steps}; composer after send: ${sent ? (sent.pass ? 'empty (sent)' : `NOT empty — ${sent.detail}`) : '?'}${r.error ? `; error ${r.error}` : ''}`);
  return !r.error && sent?.pass ? 0 : 1;
}

async function skill(args: string[]): Promise<number> {
  if (args[0] === 'smoke') return smoke(args);
  if (args[0] !== 'calibrate') {
    console.error('Usage: autotest skill calibrate --surface <s> --env <e> [--device <udid>]');
    return 2;
  }
  const surface = (flag(args, 'surface') ?? 'desktop-web') as Surface;
  const env = (flag(args, 'env') ?? 'test') as Env;
  const pool = new AccountPool();
  await pool.reload();
  const accountId = flag(args, 'account') ?? pool.list(env)[0]?.id;
  if (!accountId) throw new Error(`no ${env} account in the pool`);
  if (surface === 'android-app') {
    const { calibrateAndroid } = await import('../skills/calibrate-android');
    const p = await calibrateAndroid({ udid: flag(args, 'device'), env, packageName: flag(args, 'package') ?? 'ai.teamily.mobile' });
    return Object.values(p.elements).some((e) => e.selfCheck === 'fail') ? 1 : 0;
  }
  const { calibrateWeb } = await import('../skills/calibrate-web');
  const { sessionFile } = await import('../platform/accounts/sessions');
  const p = await calibrateWeb({ surface, env, url: pool.webUrl(env), credentials: pool.backend.get(accountId), headless: !has(args, 'headed'), sessionFile: sessionFile(accountId) });
  await pool.markLogin(accountId, true);
  return Object.values(p.elements).some((e) => e.selfCheck === 'fail') ? 1 : 0;
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
  skill,
  nodes,
  plan: async (a) => (await import('../issue/cli')).planCmd(a),
  run: async (a) => (await import('../issue/cli')).runCmd(a),
  replay: async (a) => (await import('../incident/replay')).replayCmd(a),
};
if (!cmd || !table[cmd]) {
  console.error('Usage: m5 <accounts|skill|nodes|plan|run|replay> ...');
  process.exit(2);
}
table[cmd](rest).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`[${cmd}] ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
