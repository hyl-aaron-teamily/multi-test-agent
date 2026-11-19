// W3-3 F11′: the Teamily acceptance suite for the exploration executor (fixtures/explore-suite/teamily.yaml).
// Submits each task to the running platform one after another, waits for it, and writes a comparison table:
// how it ended, steps, time, model calls (final reviews apart), reviews passed / not passed, turns without a
// usable answer, typed text that did not land, "screen did not change" marks, and the §8.6.1 attribution where
// it can be told automatically. Whether a task really succeeded is checked by a person against `pass`.
//   pnpm autotest explore suite [--only id1,id2] [--no-explore] [--file <yaml>] [--env <environment id>]
// --env (W3-4 E1 ⑧): run on that environment, e.g. android-app:emulator-5556@prod (the Teamily emulator);
// default: any android-app environment of the suite's service env.
// Output: midscene_run/explore-suite/<stamp>/ (report.md, summary.json). Deleted when the platform stops unless
// saved: pnpm autotest runs save midscene_run/explore-suite/<stamp>
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { AgentResult } from '../engine/agent/run';
import { loadConversations } from '../platform/conversations';
import { getTask } from '../platform/lifecycle/task';

interface SuiteItem {
  id: string;
  goal: string;
  writable?: boolean;
  maxMinutes?: number;
  maxSteps?: number;
  covers?: string[];
  pass?: string;
}
interface Suite {
  surface?: string;
  env?: string;
  tasks?: SuiteItem[];
  explore?: SuiteItem[];
}

export interface SuiteRow {
  id: string;
  mode: 'task' | 'explore';
  taskId?: string;
  status: string;
  summary: string;
  steps: number;
  seconds: number;
  modelCalls: number;
  checkCalls: number;
  checksPassed: number;
  checksFailed: number;
  unusable: number;
  inputNotCommitted: number;
  unchanged: number;
  findings: number;
  attribution: string;
  pass: string;
  runDir?: string;
}

const args = process.argv.slice(2);
const opt = (n: string) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : undefined);
const API = `http://localhost:${process.env.PLATFORM_PORT ?? 3210}/api/v1`;

async function call(method: string, path: string, body?: unknown): Promise<{ code: string; summary: string; data?: any }> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', 'x-autotest-client': 'cli' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await r.json()) as { code: string; summary: string; data?: any };
}

/** Pure: fill {group} / {member} / {run}; an unfilled placeholder is an error (never send to a guessed place). */
export function fill(text: string, v: Record<string, string | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => {
    const x = v[k];
    if (!x) throw new Error(`placeholder ${m} has no value (platform/conversations.local.yaml construct.allow / member)`);
    return x;
  });
}

/** Pure: {member} = another pool account in the group — not the one signed in on the device under test
 *  (construct.members lists candidates; construct.member is the default). `self` = that account's nickname. */
export function memberFor(c: { member?: string; members?: string[] }, self?: string): string | undefined {
  const all = [...(c.members ?? []), ...(c.member ? [c.member] : [])];
  return all.find((m) => m !== self) ?? (self ? undefined : all[0]);
}

/** Pure: surface / service env of an environment id `surface:device@env`. */
export function parseEnvId(id: string): { surface: string; device: string; env: string } | undefined {
  const m = id.match(/^([a-z-]+):(.+)@(test|prod)$/);
  return m ? { surface: m[1], device: m[2], env: m[3] } : undefined;
}

/** Pure: one row of the table from the agent's result. */
export function rowOf(item: SuiteItem, mode: 'task' | 'explore', r: AgentResult | undefined, taskId: string | undefined, status: string, pass: string): SuiteRow {
  const checks = r?.checks ?? [];
  const failedChecks = checks.filter((c) => !c.passed).length;
  const att = [(r?.unusable ?? 0) > 0 || /不可用的回答|没有给出可用/.test(r?.summary ?? '') ? '①' : '', (r?.inputNotCommitted ?? 0) > 0 ? '②' : '', failedChecks ? '③' : ''].filter(Boolean).join(' ');
  return {
    id: item.id,
    mode,
    taskId,
    status: r?.status ?? status,
    summary: (r?.summary ?? status).slice(0, 200),
    steps: r?.usage.steps ?? 0,
    seconds: r?.usage.seconds ?? 0,
    modelCalls: r?.usage.modelCalls ?? 0,
    checkCalls: r?.usage.checkCalls ?? 0,
    checksPassed: checks.filter((c) => c.passed && !c.error).length,
    checksFailed: failedChecks,
    unusable: r?.unusable ?? 0,
    inputNotCommitted: r?.inputNotCommitted ?? 0,
    unchanged: (r?.steps ?? []).filter((s) => s.changed === false).length,
    findings: (r?.findings ?? []).filter((f) => f.counted).length,
    attribution: att,
    pass,
    runDir: r?.runDir,
  };
}

/** Pure: the report. */
export function suiteMarkdown(rows: SuiteRow[], o: { started: string; run: string; env?: string }): string {
  const tasks = rows.filter((r) => r.mode === 'task');
  const sum = (k: keyof SuiteRow) => rows.reduce((n, r) => n + (r[k] as number), 0);
  const steps = sum('steps');
  return [
    `# Teamily 验收集（W3-3）`,
    '',
    `- 开始：${o.started}；本次标记 \`${o.run}\`${o.env ? `；环境 \`${o.env}\`` : ''}`,
    `- task 自报完成 ${tasks.filter((r) => r.status === 'completed').length} / ${tasks.length}（是否真的做对，按「通过条件」人工核对）`,
    `- 合计：${steps} 步，${sum('seconds')} 秒，模型调用 ${sum('modelCalls')} 次（其中结束复核 ${sum('checkCalls')} 次）；每步 ${steps ? (sum('seconds') / steps).toFixed(1) : '-'} 秒、${steps ? ((sum('modelCalls') - sum('checkCalls')) / steps).toFixed(2) : '-'} 次调用`,
    `- 没给出可用动作 ${sum('unusable')} 轮；输入没上屏 ${sum('inputNotCommitted')} 次；画面没变 ${sum('unchanged')} 次`,
    '',
    '| 条目 | 模式 | 结束 | 步数 | 用时 | 调用（复核） | 复核 通过/不通过 | 不可用 | 没上屏 | 画面没变 | 发现 | 归因 | 通过条件（人工核对） | 人工 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.mode} | ${r.status}：${r.summary.replace(/\|/g, '/').replace(/\n/g, ' ')} | ${r.steps} | ${r.seconds}s | ${r.modelCalls}（${r.checkCalls}） | ${r.checksPassed}/${r.checksFailed} | ${r.unusable} | ${r.inputNotCommitted} | ${r.unchanged} | ${r.findings} | ${r.attribution} | ${r.pass.replace(/\|/g, '/')} |  |`),
    '',
    '归因（§8.6.1）：① 输出不可用 ② 输入 / 文本编辑 ③ 报完成前没核对（复核不通过）④ 长任务失忆（人工判断）。',
    '',
  ].join('\n');
}

/** The nickname of a pool account = the local part of its email (aaron+test2@… → aaron+test2). */
async function nickname(accountId: string): Promise<string | undefined> {
  const { AccountPool } = await import('../platform/accounts/account-pool');
  const pool = new AccountPool();
  await pool.reload();
  return pool.get(accountId)?.email.split('@')[0];
}

async function main(): Promise<number> {
  const file = resolve(opt('file') ?? 'fixtures/explore-suite/teamily.yaml');
  const suite = yaml.load(readFileSync(file, 'utf8')) as Suite;
  const only = opt('only')?.split(',').map((s) => s.trim());
  const conv = loadConversations();
  const run = `r${Date.now().toString(36).slice(-5)}`;
  const envId = opt('env');
  const envP = envId ? parseEnvId(envId) : undefined;
  if (envId && !envP) {
    console.error(`--env: an environment id like android-app:emulator-5556@prod (pnpm autotest env list)`);
    return 2;
  }
  const envRec = envId ? await call('GET', `/envs/${encodeURIComponent(envId)}`).catch(() => undefined) : undefined;
  if (envId && envRec?.code !== 'OK') {
    console.error(`--env ${envId}: ${envRec?.summary ?? 'platform not reachable'}`);
    return 2;
  }
  const selfAccount: string | undefined = envRec?.data?.account;
  const self = selfAccount ? await nickname(selfAccount) : undefined;
  const vars = { group: conv.construct.allow[0], member: memberFor(conv.construct, self), run };
  const items = [...(suite.tasks ?? []).map((t) => ({ t, mode: 'task' as const })), ...(args.includes('--no-explore') ? [] : (suite.explore ?? []).map((t) => ({ t, mode: 'explore' as const })))].filter((x) => !only || only.includes(x.t.id));
  const ping = await call('GET', '/tasks?limit=1').catch(() => undefined);
  if (!ping) {
    console.error(`平台没在运行（${API}）：先 pnpm start`);
    return 54;
  }
  const started = new Date().toISOString();
  const dir = resolve('midscene_run/explore-suite', started.replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const rows: SuiteRow[] = [];
  for (const { t, mode } of items) {
    const goal = fill(t.goal, vars);
    const pass = t.pass ? fill(t.pass, vars) : '';
    console.log(`[suite] ${t.id} (${mode}): ${goal}`);
    const sub = await call('POST', '/tasks', { explore: goal, mode, surface: envP?.surface ?? suite.surface ?? 'android-app', env: envP?.env ?? suite.env ?? 'prod', ...(envId ? { envId } : {}), writable: !!t.writable, maxMinutes: t.maxMinutes, maxSteps: t.maxSteps });
    if (sub.code !== 'ACCEPTED') {
      console.log(`[suite] ${t.id}: not started — ${sub.code} ${sub.summary}`);
      rows.push(rowOf(t, mode, undefined, undefined, `not started: ${sub.code} ${sub.summary}`, pass));
      continue;
    }
    const id = sub.data.id as string;
    let w = await call('GET', `/tasks/${id}/wait?timeout=20`);
    while (w.code === 'STILL_RUNNING') w = await call('GET', `/tasks/${id}/wait?timeout=20`);
    const runDir = getTask(id)?.runDir;
    const result = runDir && existsSync(join(runDir, 'result.json')) ? (JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')) as AgentResult) : undefined;
    const row = rowOf(t, mode, result, id, `${w.code} ${w.summary}`, pass);
    rows.push(row);
    console.log(`[suite] ${t.id}: ${row.status} — ${row.summary} (${row.steps} steps, ${row.seconds}s)`);
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ started, run, file, rows }, null, 2));
  }
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ started, run, file, rows }, null, 2));
  writeFileSync(join(dir, 'report.md'), suiteMarkdown(rows, { started, run, env: envId }));
  console.log(`[suite] report: ${join(dir, 'report.md')}`);
  console.log(`[suite] 停平台时会被删除；要保留：pnpm autotest runs save ${join('midscene_run', 'explore-suite', started.replace(/[:.]/g, '-'))}（任务本身用 runs save <任务 id>）`);
  return 0;
}

if (process.argv[1] && /explore-suite\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) main().then((c) => process.exit(c), (e) => {
  console.error((e as Error).message);
  process.exit(1);
});
