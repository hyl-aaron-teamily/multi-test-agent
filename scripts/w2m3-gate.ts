// W2-3 real-device gate (T10, §10). Subcommands:
//   faults [--phases preflight,prepare,warmup,loop,finishing] [--faults kill-task,stall,kill-platform,adb-reconnect] [--plan <planId>]
//          fault matrix (§10.3): one injection per cell, each followed by a normal task that must conclude.
//          adb-reconnect (was adb-kill, which is still accepted as its alias): `adb -s <phone> reconnect`
//          kicks this phone's connection from the host side; the adb server keeps running and keeps its
//          keys. `adb kill-server` made the test phone drop its USB-debugging authorization every time.
//   agent  scripted agent (§10.1): only `help --json`, stdout JSON and exit codes (stderr dropped)
//   determinism   live 31 / 32 / 33 (§10.4)
//   consistency <taskId>   CLI text / --json / rendered Web page agree (§10.5, Playwright)
//   estimate      share of runs whose duration fell inside the PlanView interval (§10.8)
// The gate owns the platform process (it kills and restarts it for the kill-platform fault). Results go to
// docs/w2m3-gate/<subcommand>-<time>.json and are printed.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adb } from '../core/adb';

const TSX = resolve('node_modules/tsx/dist/cli.mjs');
const PORT = Number(process.env.PLATFORM_PORT ?? 3210);
const API = `http://localhost:${PORT}/api/v1`;
const STATE = resolve('platform/state');
const OUT = resolve('docs/w2m3-gate');
const ENV_ID = 'android-app:4f2ebdf2@prod';
const UDID = ENV_ID.match(/:([^@]+)@/)![1];
/** How long the phone may stay off adb after a reconnect before the run stops (no long wait for a person). */
const RECONNECT_WAIT_MS = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flag = (n: string) => (process.argv.indexOf(`--${n}`) >= 0 ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const log = (s: string) => {
  const line = `[gate ${new Date().toISOString().slice(11, 19)}] ${s}`;
  console.log(line);
  appendFileSync(join(OUT, 'gate.log'), `${line}\n`);
};

/** The CLI exactly as an agent calls it: stdout JSON + exit code, stderr dropped. */
export function cli(args: string[]): { exit: number; json: any } {
  const r = spawnSync(process.execPath, [TSX, 'bin/autotest.ts', ...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30 * 60_000, windowsHide: true });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = { parseError: r.stdout.slice(0, 300) };
  }
  return { exit: r.status ?? -1, json };
}

async function get(path: string): Promise<any> {
  try {
    return await (await fetch(`${API}${path}`)).json();
  } catch {
    return undefined;
  }
}
const web = async (method: string, path: string, body?: unknown) => (await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', 'x-autotest-client': 'web' }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;

const taskRec = (id: string): any => {
  const f = join(STATE, 'tasks', id, 'task.json');
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
  } catch {
    return undefined;
  }
};
const envRec = (): any => JSON.parse(readFileSync(join(STATE, 'envs', `${ENV_ID.replace(/[^\w.@-]/g, '_')}.json`), 'utf8'));

function platformPid(): number | undefined {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8', windowsHide: true });
  const n = Number(r.stdout.trim());
  return n > 0 ? n : undefined;
}

async function startPlatform(): Promise<void> {
  if (await get('/envs')) return;
  const fd = openSync(join(OUT, 'platform.log'), 'a');
  const p = spawn(process.execPath, [TSX, 'platform/server.ts'], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  p.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await get('/envs')) return;
  }
  throw new Error('platform did not start');
}

/** Kill the platform process only (its task children keep running — like closing its window). */
function killPlatform(): void {
  const pid = platformPid();
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
}

const alive = (pid?: number) => !!pid && spawnSync('powershell.exe', ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'y' }`], { encoding: 'utf8', windowsHide: true }).stdout.trim() === 'y';

async function waitEnvSettled(maxMs = 6 * 60_000): Promise<any> {
  const t0 = Date.now();
  for (;;) {
    const e = envRec();
    if (!['leased', 'recovering', 'checking', 'draining'].includes(e.state) && !e.lease) return e;
    if (Date.now() - t0 > maxMs) return e;
    await sleep(1000);
  }
}

async function waitTerminal(id: string, maxMs = 10 * 60_000): Promise<any> {
  const T = ['done', 'env-unfit', 'failed', 'interrupted', 'cancelled', 'timed-out'];
  const t0 = Date.now();
  for (;;) {
    const t = taskRec(id);
    if (t && T.includes(t.state)) return t;
    if (Date.now() - t0 > maxMs) return t;
    await sleep(1000);
  }
}

async function ensureReady(maxMs = 12 * 60_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const e = await waitEnvSettled();
    if (e.state === 'ready') return true;
    if (Date.now() - t0 > maxMs) return false;
    log(`env ${e.state} (${e.reason ?? ''}) — env check (waiting for the phone / a person, ${Math.round((Date.now() - t0) / 1000)} s)`);
    cli(['env', 'check', ENV_ID]);
    if ((await waitEnvSettled()).state === 'ready') return true;
    await sleep(20_000);
  }
}

/** The phone is back on adb (state "device") within `maxMs`. */
async function waitAdbDevice(maxMs = RECONNECT_WAIT_MS): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const st = (await adb(['get-state'], UDID, 5000).catch(() => '')).trim();
    if (st === 'device') return true;
    if (Date.now() - t0 > maxMs) return false;
    await sleep(3000);
  }
}

/** No task record says "live" while its process is gone (§10.3). */
function liveButDead(): string[] {
  const dir = join(STATE, 'tasks');
  const out: string[] = [];
  for (const d of existsSync(dir) ? readdirSync(dir) : []) {
    const t = taskRec(d);
    if (t && ['preflight', 'running', 'finishing'].includes(t.state) && !(t.proc && alive(t.proc.pid))) out.push(`${t.id} ${t.state}`);
  }
  return out;
}

const PHASES = ['preflight', 'prepare', 'warmup', 'loop', 'finishing'];
const FAULTS = ['kill-task', 'stall', 'kill-platform', 'adb-reconnect'];
/** Old fault names (records under docs/w2m3-gate/ still carry them). */
const FAULT_ALIAS: Record<string, string> = { 'adb-kill': 'adb-reconnect' };

async function inject(fault: string, t: any): Promise<string> {
  const pid = t.proc?.pid;
  if (fault === 'kill-task') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return `taskkill /T /F ${pid}`;
  }
  if (fault === 'stall') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/fault/suspend.ps1', '-ProcessId', String(pid)], { encoding: 'utf8', windowsHide: true });
    return `NtSuspendProcess ${pid} → ${r.status}`;
  }
  if (fault === 'kill-platform') {
    const p = platformPid();
    killPlatform();
    await sleep(2000);
    await startPlatform();
    return `platform ${p} killed, restarted (pid ${platformPid()})`;
  }
  // adb-reconnect: only this phone's transport is dropped (its shell / logcat streams end); the server and
  // the other devices are untouched, and the phone comes back by itself.
  await adb(['reconnect'], UDID, 15_000).catch(() => '');
  return `adb -s ${UDID} reconnect`;
}

/** What the record must say after a fault (besides the generic invariants). */
function expected(fault: string, t: any): string | undefined {
  if (fault === 'kill-task' && !(t.state === 'interrupted' && t.outcome?.code === 'TASK_CRASHED' && t.endedBy === 'crash')) return 'kill-task → interrupted / TASK_CRASHED / crash';
  if (fault === 'stall' && !(t.state === 'failed' && t.outcome?.code === 'TASK_STUCK' && t.endedBy === 'stuck')) return 'stall → failed / TASK_STUCK / stuck';
  if (fault === 'kill-platform' && !((t.state === 'done' && t.endedBy === 'normal') || (t.state === 'interrupted' && t.outcome?.code === 'INTERRUPTED' && t.endedBy === 'server-restart'))) return 'kill-platform → adopted and done, or interrupted / INTERRUPTED / server-restart';
  // A lost adb connection is the environment: 5x, or a normal conclusion if the run rode it out.
  if (fault === 'adb-reconnect' && !(/^ENV_/.test(t.outcome?.code ?? '') || ['NOT_REPRODUCED', 'REPRODUCED', 'TASK_CRASHED', 'TASK_STUCK'].includes(t.outcome?.code))) return 'adb-reconnect → ENV_* (or a conclusion)';
  return undefined;
}

function invariants(t: any, e: any): string[] {
  const bad: string[] = [];
  if (!t?.outcome?.code) bad.push('task has no outcome code');
  if (!t?.endedBy) bad.push('task has no endedBy');
  if (t?.endedBy && t.endedBy !== 'normal' && !t.endedAt?.phase) bad.push('interrupted task without stop position');
  if (e.state === 'ready' && !e.baseline?.ok) bad.push('env ready but baseline failed');
  if (!['ready', 'quarantined', 'unfit'].includes(e.state)) bad.push(`env left in ${e.state}`);
  if ((e.state === 'quarantined' || e.state === 'unfit') && !e.reason) bad.push(`env ${e.state} without a reason`);
  return bad;
}

async function faults(): Promise<void> {
  const plan = flag('plan') ?? '2010/main:android-app@v1';
  const phases = (flag('phases') ?? PHASES.join(',')).split(',');
  const fl = (flag('faults') ?? FAULTS.join(',')).split(',').map((f) => FAULT_ALIAS[f] ?? f);
  await startPlatform();
  const rows: any[] = [];
  const file = join(OUT, `faults-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  outer: for (const phase of phases)
    for (const fault of fl) {
      const row: any = { phase, fault, at: new Date().toISOString() };
      rows.push(row);
      if (!(await ensureReady())) {
        row.error = `env not ready: ${envRec().state} ${envRec().reason ?? ''}`;
        log(`${phase}/${fault}: SKIP — ${row.error}`);
        writeFileSync(file, JSON.stringify(rows, null, 2));
        continue;
      }
      const sub = cli(['task', 'run', plan, '--max-rounds', phase === 'loop' ? '4' : '2']);
      const id = sub.json?.data?.id;
      if (sub.exit !== 20 || !id) {
        row.error = `task run → ${sub.exit} ${JSON.stringify(sub.json).slice(0, 200)}`;
        log(`${phase}/${fault}: ${row.error}`);
        continue;
      }
      row.task = id;
      // Wait for the phase (loop: round 1 started), then inject.
      let t: any;
      const t0 = Date.now();
      for (;;) {
        t = taskRec(id);
        const ph = t?.progress?.phase;
        if (ph === phase && t.proc?.pid && (phase !== 'loop' || (t.progress.round ?? 0) >= 1)) break;
        if (t && ['done', 'env-unfit', 'failed', 'interrupted', 'cancelled', 'timed-out'].includes(t.state)) break;
        if (Date.now() - t0 > 8 * 60_000) break;
        await sleep(150);
      }
      if (t?.progress?.phase !== phase) {
        row.error = `phase ${phase} not reached (state ${t?.state}, phase ${t?.progress?.phase})`;
        log(`${phase}/${fault}: ${row.error}`);
        await waitTerminal(id);
        continue;
      }
      row.injectedAt = { ...t.progress };
      row.injection = await inject(fault, t);
      log(`${phase}/${fault}: task ${id} @ ${JSON.stringify(row.injectedAt)} — ${row.injection}`);
      const end = await waitTerminal(id);
      if (fault === 'adb-reconnect' && !(await waitAdbDevice())) {
        // Every later cell needs the phone: stop instead of waiting for a person.
        row.error = `phone not back on adb ${RECONNECT_WAIT_MS / 1000} s after the reconnect (check the cable / the USB-debugging prompt on the phone)`;
        log(`${phase}/${fault}: STOP — ${row.error}`);
        writeFileSync(file, JSON.stringify(rows, null, 2));
        break outer;
      }
      const env = await waitEnvSettled();
      row.task = { id, state: end?.state, code: end?.outcome?.code, endedBy: end?.endedBy, endedAt: end?.endedAt, recovery: end?.recovery?.result, partial: end?.partial };
      row.env = { state: env.state, baselineOk: env.baseline?.ok, reason: env.reason };
      row.liveButDead = liveButDead();
      const exp = expected(fault, end);
      row.failures = [...(exp ? [`expected ${exp}; got ${end?.state}/${end?.outcome?.code}/${end?.endedBy}`] : []), ...invariants(end, env), ...row.liveButDead.map((x: string) => `live record with dead process: ${x}`)];
      // The next normal task concludes.
      if (await ensureReady()) {
        const n = cli(['task', 'run', plan, '--max-rounds', '1']);
        const nid = n.json?.data?.id;
        const w = nid ? cli(['task', 'wait', nid, '--timeout', '900']) : { exit: n.exit, json: n.json };
        row.next = { task: nid, exit: w.exit, code: w.json?.code };
        if (![10, 11].includes(w.exit)) row.failures.push(`next normal task did not conclude: ${w.exit} ${w.json?.code}`);
      } else row.failures.push(`env not ready for the next task: ${envRec().state} ${envRec().reason ?? ''}`);
      row.pass = !row.failures.length;
      log(`${phase}/${fault}: ${row.pass ? 'PASS' : 'FAIL'} — task ${row.task.state}/${row.task.code}/${row.task.endedBy} @${JSON.stringify(row.task.endedAt)}; env ${row.env.state}; next ${row.next?.code ?? '-'}${row.failures.length ? `; ${row.failures.join('; ')}` : ''}`);
      writeFileSync(file, JSON.stringify(rows, null, 2));
    }
  const done = rows.filter((r) => r.pass !== undefined);
  log(`faults: ${done.filter((r) => r.pass).length}/${done.length} passed (${rows.length - done.length} not run) → ${file}`);
}

/** §10.1: a scripted agent that reads only help --json, stdout JSON and exit codes. */
async function agent(): Promise<void> {
  await startPlatform();
  const steps: any[] = [];
  const step = (name: string, args: string[]) => {
    const r = cli(args);
    steps.push({ name, args, exit: r.exit, code: r.json?.code, summary: r.json?.summary });
    log(`agent ${name}: exit ${r.exit} ${r.json?.code} — ${String(r.json?.summary ?? '').slice(0, 140)}`);
    return r;
  };
  const help = step('help', ['help']);
  const cmds: string[] = help.json.data.commands.map((c: any) => c.command);
  for (const c of ['draft create', 'plan explain', 'task run', 'task wait', 'result show']) if (!cmds.includes(c)) throw new Error(`help lacks ${c}`);
  const exitOf = (code: string) => help.json.data.statusCodes.find((s: any) => s.code === code).exit;
  const draft = step('draft create', ['draft', 'create', '2010', '--no-model']);
  const planId: string = draft.json.data.plans.find((p: string) => p.includes(':android-app@'));
  const ex = step('plan explain', ['plan', 'explain', planId]);
  if (ex.json.data.approval.category !== 'default') throw new Error('2010 should be default-class');
  const run = step('task run', ['task', 'run', planId, '--hash', ex.json.data.hash]);
  if (run.exit !== exitOf('ACCEPTED')) throw new Error(`task run exit ${run.exit}`);
  const id = run.json.data.id;
  let w = step('task wait', ['task', 'wait', id, '--timeout', '1200']);
  while (w.exit === exitOf('STILL_RUNNING')) w = step('task wait', ['task', 'wait', id, '--timeout', '1200']);
  const res = step('result show', ['result', 'show', id]);
  const conclusionOk = [exitOf('NOT_REPRODUCED'), exitOf('REPRODUCED')].includes(res.exit) && res.exit === w.exit;
  // Sensitive plan: full access off → 30 → a person agrees on the Web → accepted and runs.
  const fa0 = (await web('GET', '/full-access')).data;
  await web('POST', '/full-access', { on: false });
  const s1 = step('task run (series 21, sensitive)', ['task', 'run', planId, '--series', '21', '--max-rounds', '1']);
  const got30 = s1.exit === exitOf('APPROVAL_REQUIRED');
  const hint = s1.json?.error?.hint;
  // Full access is off by default now: the sensitive approval is the user's own Web click (not automated).
  const clicked = false;
  const s2 = { exit: -1, json: {} as any };
  const sw = s2;
  const sres = undefined as any;
  if (fa0?.on) await web('POST', '/full-access', { on: true });
  const out = { planId, task: id, conclusion: res.json?.data?.sentence, exit: res.exit, conclusionOk, sensitive: { got30, hint, webClicked: clicked, accepted: s2.exit === exitOf('ACCEPTED'), seriesExit: sw.exit, seriesSentence: sres?.json?.data?.sentence }, steps };
  writeFileSync(join(OUT, `agent-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(out, null, 2));
  log(`agent: conclusion ${conclusionOk ? 'OK' : 'FAIL'} (${out.conclusion}); sensitive: 30 ${got30}, web ${clicked}, accepted ${out.sensitive.accepted}, series exit ${sw.exit}`);
}

/** Press 「同意」 on the plan page (the person's button) with Playwright. */
async function approveOnWeb(planId: string, series: number): Promise<boolean> {
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    p.on('dialog', (d) => void d.accept());
    await p.goto(`http://localhost:${PORT}/plan.html?id=${encodeURIComponent(planId)}&series=${series}`);
    await p.getByRole('button', { name: '同意', exact: true }).click();
    await p.waitForTimeout(1500);
    const a = await get(`/plans/${encodeURIComponent(planId)}?series=${series}`);
    return a?.data?.approval?.state === 'approved' && /\/21/.test(a.data.approval.runs ?? '');
  } finally {
    await b.close();
  }
}

/** §10.4 live: 31 (wrong hash), 32 (profile changed after approval), 33 (runs used up). */
async function determinism(): Promise<void> {
  await startPlatform();
  const planId = flag('plan') ?? '2010/main:android-app@v1';
  const ex = cli(['plan', 'explain', planId]);
  const h = ex.json.data.hash;
  const r31 = cli(['task', 'run', planId, '--hash', '0000000000000000', '--dry-run']);
  const ap = cli(['plan', 'approve', planId, '--hash', h, '--runs', '1']);
  // 32: the calibrated profile changes after the approval (a trailing newline: same content, new hash).
  const prof = resolve('skills/teamily/profiles/android-4f2ebdf2@prod.json');
  const orig = readFileSync(prof, 'utf8');
  writeFileSync(prof, `${orig}\n`);
  let r32: ReturnType<typeof cli>;
  try {
    r32 = cli(['task', 'run', planId]);
  } finally {
    writeFileSync(prof, orig);
  }
  // 33: one approved run, used by a task that is cancelled while queued; the second run is refused.
  const ap2 = cli(['plan', 'approve', planId, '--hash', h, '--runs', '1']);
  const first = cli(['task', 'run', planId]);
  const cancel = first.json?.data?.id ? cli(['task', 'cancel', first.json.data.id]) : undefined;
  const r33 = cli(['task', 'run', planId]);
  const out = { r31: { exit: r31.exit, code: r31.json.code }, approve: ap.exit, r32: { exit: r32.exit, code: r32.json.code, msg: r32.json.summary }, approve2: ap2.exit, first: first.exit, cancel: cancel?.exit, r33: { exit: r33.exit, code: r33.json.code, msg: r33.json.summary }, pass: r31.exit === 31 && r32.exit === 32 && r33.exit === 33 };
  writeFileSync(join(OUT, `determinism-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(out, null, 2));
  log(`determinism: 31→${r31.exit} 32→${r32.exit} 33→${r33.exit} ${out.pass ? 'PASS' : 'FAIL'}`);
}

/** §10.5: the same result on the CLI text, --json and the rendered Web page. */
async function consistency(taskId: string): Promise<void> {
  await startPlatform();
  const j = cli(['result', 'show', taskId]).json.data;
  const txt = spawnSync(process.execPath, [TSX, 'bin/autotest.ts', 'result', 'show', taskId], { encoding: 'utf8', windowsHide: true }).stdout;
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  let page: { sentence: string; valid?: string; hits?: string; interval?: string };
  try {
    const p = await b.newPage();
    await p.goto(`http://localhost:${PORT}/result.html?id=${encodeURIComponent(taskId)}`);
    await p.waitForSelector('#sentence');
    page = { sentence: (await p.locator('#sentence').innerText()).trim(), valid: await p.locator('.valid').first().innerText().catch(() => undefined), hits: await p.locator('.hits').first().innerText().catch(() => undefined), interval: await p.locator('.interval').first().innerText().catch(() => undefined) };
  } finally {
    await b.close();
  }
  const r0 = j.runs[0];
  const checks = {
    sentence: page.sentence === j.sentence && txt.includes(`结论：${j.sentence}`),
    valid: !r0?.attempts || (page.valid === String(r0.attempts.valid) && txt.includes(`有效尝试 ${r0.attempts.valid}，`)),
    hits: !r0?.attempts || (page.hits === String(r0.attempts.hits) && txt.includes(`命中 ${r0.attempts.hits}，`)),
    interval: !r0?.attempts || (page.interval === r0.attempts.text && txt.includes(r0.attempts.text)),
  };
  const out = { taskId, json: { sentence: j.sentence, attempts: r0?.attempts }, page, checks, pass: Object.values(checks).every(Boolean) };
  writeFileSync(join(OUT, `consistency-${taskId}.json`), JSON.stringify(out, null, 2));
  log(`consistency ${taskId}: ${JSON.stringify(checks)} ${out.pass ? 'PASS' : 'FAIL'}`);
}

/** §10.8: did each finished run's duration fall inside the interval the PlanView gave before it ran? */
async function estimate(): Promise<void> {
  const { planView, planHistory } = await import('../platform/views');
  const { classifyPlan } = await import('../platform/approval');
  const rows: any[] = [];
  for (const d of readdirSync(join(STATE, 'tasks'))) {
    const t = taskRec(d);
    if (!t || t.parent || t.state !== 'done' || t.series || !existsSync(join(STATE, 'tasks', d, 'result.json'))) continue;
    const res = JSON.parse(readFileSync(join(STATE, 'tasks', d, 'result.json'), 'utf8'));
    const plan = JSON.parse(readFileSync(join(STATE, 'tasks', d, 'plan.json'), 'utf8'));
    for (const r of (res.runs ?? []).filter((x: any) => !['环境不合格', '执行失败', '计划不可执行', 'SKILL 失效'].includes(x.conclusion) && !x.cancelled)) {
      // The interval the plan view gave before this run: only runs that started earlier count as history.
      const v = planView({ id: t.planId, hash: '', plan, classified: classifyPlan(plan), history: planHistory(plan.id, undefined, r.startedAt), maxRounds: t.options.maxRounds });
      rows.push({ task: d, maxRounds: t.options.maxRounds, sec: r.stats.durationSec, min: v.estimate.minSec, max: v.estimate.maxSec, basis: v.estimate.basis, inside: r.stats.durationSec >= v.estimate.minSec && r.stats.durationSec <= v.estimate.maxSec });
    }
  }
  const inside = rows.filter((r) => r.inside).length;
  writeFileSync(join(OUT, `estimate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ inside, total: rows.length, rows }, null, 2));
  log(`estimate: ${inside}/${rows.length} runs inside the PlanView interval (${rows.length ? Math.round((inside / rows.length) * 100) : 0}%)`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const cmd = process.argv[2];
  if (cmd === 'faults') return faults();
  if (cmd === 'agent') return agent();
  if (cmd === 'determinism') return determinism();
  if (cmd === 'consistency') return consistency(process.argv[3]);
  if (cmd === 'estimate') return estimate();
  console.error('usage: tsx scripts/w2m3-gate.ts faults|agent|determinism|consistency <taskId>|estimate');
  process.exitCode = 40;
}

if (process.argv[1] && /w2m3-gate\.ts$/.test(process.argv[1])) main().then(() => process.exit(process.exitCode ?? 0), (e) => {
  console.error(e);
  process.exit(1);
});
