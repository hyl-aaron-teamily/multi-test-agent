// Milestone 5 CLI: Issue-driven black-box reproduction.
//   pnpm autotest accounts list|check [--env test|prod] [--force] [--id <acc>]
//   pnpm autotest skill calibrate --surface desktop-web|mobile-web|android-app|android-web --env test|prod [--device <udid>] [--account <id>] [--headed]
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
import { emitTaskResult } from '../core/task-result';

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
async function smoke(args: string[]): Promise<number> {
  const surface = (flag(args, 'surface') ?? 'desktop-web') as Surface;
  const env = (flag(args, 'env') ?? 'prod') as Env;
  const { runPlan, runDirFor } = await import('../executor/run');
  const { SKILL_VERSION } = await import('../skills/teamily/vocab');
  const { pool, devices } = await openPools();
  const id = `smoke-${surface}-${env}`;
  // --crash-after S (android): loop open/back and inject `am crash` after S seconds (flight-recorder check).
  const crashAfter = flag(args, 'crash-after') ? Number(flag(args, 'crash-after')) : undefined;
  if (crashAfter && surface === 'android-app') {
    const { adb } = await import('../core/adb');
    const udid = flag(args, 'device') ?? (await devices.refresh()).find((x) => x.status === 'idle')?.udid;
    setTimeout(() => {
      console.log(`[smoke] injecting: am crash ai.teamily.mobile`);
      void adb(['shell', 'am', 'crash', TEAMILY_PACKAGE], udid).catch((e) => console.error(e.message));
    }, crashAfter * 1000);
  }
  const loopActions = [
    { type: 'node' as const, node: { name: 'teamily.openConversation', input: { target: 'conv' } }, delayAfterMs: 900 },
    { type: 'back' as const, delayAfterMs: 900 },
  ];
  // --lifecycle warm|cold (android-app / android-web): leave the app (Home) → wait in the background → [kill
  // its process → wait] → launch again. App: warm comes back on the chat page, cold starts on the home screen.
  // Browser: warm keeps the conversation; cold reloads the address and Teamily web reopens the conversation.
  const lifecycle = flag(args, 'lifecycle') as 'warm' | 'cold' | undefined;
  if (lifecycle) return lifecycleSmoke(args, lifecycle, { env, pool, devices, runPlan, runDirFor, SKILL_VERSION });
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
      actions: crashAfter ? loopActions : [{ type: 'node', node: { name: 'teamily.sendMessage', input: { text: `autotest smoke ${new Date().toISOString().slice(11, 19)} {token}` } }, delayAfterMs: 1000 }],
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

async function lifecycleSmoke(args: string[], mode: 'warm' | 'cold', x: { env: Env; pool: AccountPool; devices: import('../platform/device-pool').DevicePool; runPlan: typeof import('../executor/run').runPlan; runDirFor: (id: string) => string; SKILL_VERSION: string }): Promise<number> {
  const idle = String(Number(flag(args, 'idle') ?? 5000));
  const rounds = Number(flag(args, 'rounds') ?? 2);
  // android-web: the same on the phone's browser (Teamily web reopens the last conversation after a cold load).
  const surface = (flag(args, 'surface') === 'android-web' ? 'android-web' : 'android-app') as 'android-app' | 'android-web';
  const id = `lifecycle-${mode}-${surface}-${x.env}`;
  const frag = patternById('lifecycle')!.build(surface, { mode, idle });
  const r = await x.runPlan({
    plan: {
      id,
      issueRef: 'lifecycle',
      ...frag,
      category: 'bug-intermittent',
      surface,
      issueSurfaces: [],
      env: x.env,
      launch: 'once',
      prepare: [],
      afterCheck: frag.afterCheck ?? [],
      limits: { maxSteps: frag.actions.length * rounds, maxMinutes: 15, maxIntervalMs: 1000 },
      verdictRule: { anyHit: true },
      provenance: { generatedBy: 'manual', skillVersion: x.SKILL_VERSION },
    },
    runDir: x.runDirFor(id),
    pool: x.pool,
    devices: x.devices,
    udid: flag(args, 'device'),
  });
  for (const l of r.roundLog) console.log(`[lifecycle] round ${l.round}: ${l.results.map((c) => `${c.kind}=${c.pass ? 'ok' : 'FAIL'} (${c.detail})`).join('; ')}`);
  console.log(`[lifecycle] ${mode}: ${r.conclusion} — ${r.conclusionDetail}; launches ${r.stats.launches}, anomaly-gate ${r.stats.anomalyGateTriggers} (suspect ${r.stats.suspectSignals})${r.error ? `; error ${r.error}` : ''}`);
  return !r.error && r.hits.length === 0 && r.roundLog.length > 0 ? 0 : 1;
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
  const { DevicePool } = await import('../platform/device-pool');
  const devices = new DevicePool();
  await devices.reloadConfig();
  const pooled = await devices.refresh();
  const udid = flag(args, 'device') ?? pooled.find((d) => d.kind === 'android' && d.status !== 'offline')?.udid;
  // The account signed in on that surface of the phone (devices.yaml), else the first of the env.
  const signed = pooled.find((d) => d.udid === udid)?.accounts[surface];
  const accountId = flag(args, 'account') ?? (signed && pool.get(signed)?.env === env ? signed : undefined) ?? pool.list(env)[0]?.id;
  if (!accountId) throw new Error(`no ${env} account in the pool`);
  if (surface === 'android-web') {
    if (!udid) throw new Error('android-web calibration needs a phone (--device)');
    const { calibrateAndroidWeb } = await import('../skills/calibrate-android-web');
    const p = await calibrateAndroidWeb({ udid, env, url: pool.webUrl(env), credentials: pool.backend.get(accountId) });
    await pool.markLogin(accountId, true);
    return Object.values(p.elements).some((e) => e.selfCheck === 'fail') ? 1 : 0;
  }
  if (surface === 'android-app') {
    const { calibrateAndroid } = await import('../skills/calibrate-android');
    const p = await calibrateAndroid({ udid: flag(args, 'device'), env, packageName: flag(args, 'package') ?? TEAMILY_PACKAGE });
    return Object.values(p.elements).some((e) => e.selfCheck === 'fail') ? 1 : 0;
  }
  const { calibrateWeb } = await import('../skills/calibrate-web');
  const { sessionFile } = await import('../executor/login/sessions');
  const p = await calibrateWeb({ surface: surface as 'desktop-web' | 'mobile-web', env, url: pool.webUrl(env), credentials: pool.backend.get(accountId), headless: !has(args, 'headed'), sessionFile: sessionFile(accountId) });
  await pool.markLogin(accountId, true);
  return Object.values(p.elements).some((e) => e.selfCheck === 'fail') ? 1 : 0;
}

/** Multi-client sync: each role a surface on a pooled endpoint, signed in as a different account. */
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
  emitTaskResult({ report: resolve(runDir, 'report.md'), verdict: `${r.conclusion} — ${r.detail}` });
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
  skill,
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
  console.error('Usage: m5 <accounts|skill|nodes|plan|run|series|rerender|replay|evidence|sync> ...');
  process.exit(2);
}
table[cmd](rest).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`[${cmd}] ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
