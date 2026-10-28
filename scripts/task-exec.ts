// `autotest task exec <taskId>` (internal; spawned by the platform): run a submitted task in this process.
// Reads the frozen plan from the task dir (confirmation = execution), runs it on the leased environment with
// the lifecycle hooks (heartbeat, progress, ledger before effects, cancel at step boundaries), writes the
// usual Issue report (unchanged format) and result.json, and ends the task record in its real state.
// The environment's recovery is not done here: the platform runs `autotest env recover` after this exits.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RunResult } from '../executor/run';
import { summarizeSeries, type SeriesRun } from '../executor/series';
import type { Draft } from '../issue/planner';
import { getEnv } from '../platform/lifecycle/env';
import { TaskRuntime } from '../platform/lifecycle/runtime';
import { type Code, codeOfRuns } from '../platform/lifecycle/status';
import { readJson } from '../platform/lifecycle/store';
import { createTask, getTask, isTerminal, moveTask, taskDir, type TaskState, updateTask, writeResult } from '../platform/lifecycle/task';
import { type TestPlan, TestPlanZ } from '../platform/schema/test-plan';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Pure: the code a preflight failure maps to (locked phone / offline device / other). */
export function unfitCode(reason: string): Code {
  if (/^online:/.test(reason)) return 'ENV_OFFLINE';
  if (/锁屏|keyguard true/.test(reason)) return 'ENV_LOCKED';
  return 'ENV_UNFIT';
}

/** Move a record forward through the states a normal run passes (series children). */
function advance(id: string, to: TaskState[], basis: string): void {
  for (const s of to) if (getTask(id)!.state !== s) moveTask(id, s, 'task', basis);
}

export async function execTask(id: string): Promise<number> {
  const t0 = getTask(id);
  if (!t0) throw new Error(`no task ${id}`);
  const rt = new TaskRuntime(id);
  rt.start();
  const env = getEnv(t0.envId)!;
  const plan: TestPlan = TestPlanZ.parse(readJson(join(taskDir(id), 'plan.json')));
  const draft = readJson<Draft>(join(taskDir(id), 'draft.json'))!;
  rt.move('preflight', `process ${process.pid} started`);
  let child: string | undefined;
  const hooks = {
    phase: (p: Parameters<TaskRuntime['phase']>[0]) => {
      rt.phase(p);
      const s = getTask(id)!.state;
      if (p !== 'preflight' && p !== 'finishing' && s === 'preflight') rt.move('running', 'preflight passed');
      if (p === 'finishing' && (s === 'running' || s === 'preflight')) rt.move('finishing', 'run finishing (epilogue / teardown)');
      if (child) {
        const cs = getTask(child)!.state;
        if (p === 'preflight' && cs === 'waiting-env') moveTask(child, 'preflight', 'task', 'series run started');
        if (p !== 'preflight' && p !== 'finishing' && cs === 'preflight') moveTask(child, 'running', 'task', 'preflight passed');
        if (p === 'finishing' && (cs === 'running' || cs === 'preflight')) moveTask(child, 'finishing', 'task', 'run finishing');
        updateTask(child, (c) => void (c.progress = { phase: p, at: new Date().toISOString() }));
      }
    },
    beforeAction: rt.beforeAction.bind(rt),
    effect: rt.effect.bind(rt),
    shouldStop: rt.shouldStop.bind(rt),
  };
  const { openPools } = await import('../platform/pools');
  const { runPlan } = await import('../executor/run');
  const { writeIssueReport } = await import('../issue/report');
  const { pool, devices } = await openPools();
  const n = t0.series?.runs ?? 1;
  const dir = n > 1 ? resolve('midscene_run/series', `${plan.issueRef}-${id}-${stamp()}`) : resolve('midscene_run/issues', `${plan.id}-${stamp()}`);
  await mkdir(dir, { recursive: true });
  updateTask(id, (x) => void (x.runDir = dir));
  const results: RunResult[] = [];
  const series: SeriesRun[] = [];
  let report: string | undefined;
  const writeOut = (code: Code) => writeResult(id, { schemaVersion: 1, taskId: id, planId: t0.planId, code, runs: results, report, runDir: dir, ...(n > 1 ? { series: summarizeSeries(series) } : {}) });
  for (let i = 1; i <= n; i++) {
    if (rt.shouldStop()) break;
    const runDir = n > 1 ? join(dir, `run-${String(i).padStart(2, '0')}`) : join(dir, plan.id);
    if (n > 1) {
      child = `${id}.${i}`;
      createTask({ id: child, kind: 'issue', issue: t0.issue, planId: t0.planId, planHash: t0.planHash, approvalId: t0.approvalId, envId: t0.envId, parent: id, options: t0.options });
      advance(child, ['waiting-env'], `series run ${i}/${n}`);
    }
    let r: RunResult;
    try {
      r = await runPlan({ plan, runDir, pool, devices, udid: env.udid, maxRounds: t0.options.maxRounds, maxSteps: t0.options.maxSteps, maxMinutes: t0.options.maxMinutes, taskId: child ?? id, hooks });
    } catch (e) {
      // runPlan returns on its own errors; one escaping it is classified like any failure (env or tool).
      const msg = (e as Error).message.split('\n')[0];
      const { classifyFailure } = await import('../executor/failure');
      const { envSnapshot } = await import('../executor/preflight');
      const snap = env.udid ? await envSnapshot(env.udid, env.package ?? '').catch(() => undefined) : undefined;
      const f = classifyFailure('执行失败', msg, snap);
      r = { planId: plan.id, issue: plan.issueRef, title: plan.title, category: plan.category, surface: plan.surface, env: plan.env, conclusion: '执行失败', conclusionDetail: msg, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stats: {} as RunResult['stats'], hits: [], incidents: [], targets: [], roundLog: [], error: msg, failure: f.rule === 'default' ? { ...f, rule: 'uncaught-in-run' } : f };
    }
    results.push(r);
    series.push({ index: i, dir: runDir, result: r });
    if (child) {
      const code = r.cancelled ? 'CANCELLED' : codeOfRuns([r]);
      if (r.cancelled) advance(child, ['recovering', 'cancelled'], 'cancel requested');
      else if (r.conclusion === '环境不合格' && getTask(child)!.state === 'preflight') moveTask(child, 'env-unfit', 'task', r.conclusionDetail);
      else advance(child, [...(getTask(child)!.state === 'preflight' ? (['running'] as TaskState[]) : []), 'finishing', 'done'], 'run ended');
      updateTask(child, (c) => void Object.assign(c, { outcome: { code, summary: r.conclusion }, endedBy: r.cancelled ? 'cancel' : 'normal', runDir }));
    }
    writeOut('STILL_RUNNING');
    // A series stops on a locked / offline phone: the remaining runs would all be 环境不合格.
    if (r.conclusion === '环境不合格' && ['ENV_LOCKED', 'ENV_OFFLINE'].includes(unfitCode(r.conclusionDetail.replace(/^预检不合格：/, '')))) break;
  }
  rt.phase('finishing');
  report = await writeIssueReport(draft, results, n > 1 ? join(dir) : dir).catch(() => undefined);
  const cancelled = results.some((r) => r.cancelled) || (rt.shouldStop() && results.length < n);
  const last = results.at(-1);
  let code: Code;
  let state: TaskState;
  if (cancelled) {
    code = 'CANCELLED';
    state = 'cancelled';
  } else if (n === 1 && last?.conclusion === '环境不合格') {
    code = unfitCode(last.conclusionDetail.replace(/^预检不合格：/, ''));
    state = 'env-unfit';
  } else {
    code = n > 1 ? 'SERIES_DONE' : codeOfRuns(results);
    state = 'done';
  }
  writeOut(code);
  const pos = rt.position;
  const valid = results.reduce((s, r) => s + (r.attempts?.valid ?? 0), 0);
  const hits = results.reduce((s, r) => s + (r.attempts?.hits ?? 0), 0);
  const cur = getTask(id)!.state;
  const patch = (x: Parameters<Parameters<typeof updateTask>[1]>[0]) => {
    x.outcome = { code, summary: n > 1 ? `系列 ${results.length}/${n} 次` : (last?.cancelled ? '已取消' : last?.conclusion) ?? code };
    x.endedBy = cancelled ? 'cancel' : 'normal';
    x.endedAt = pos;
    x.report = report;
    if (cancelled) x.partial = { valid, hits, note: '不完整，不给结论' };
  };
  if (state === 'cancelled') advance(id, [...(cur === 'preflight' ? (['running'] as TaskState[]) : []), 'recovering'], 'cancel requested');
  if (state === 'env-unfit' && cur !== 'preflight') advance(id, ['recovering'], 'environment unfit');
  if (state === 'done' && cur === 'preflight') advance(id, ['running'], 'run ended');
  if (state === 'done') advance(id, ['finishing'], 'run ended');
  moveTask(id, state, 'task', `run ended: ${code}`, patch);
  rt.stop();
  return 0;
}

if (process.argv[1] && /task-exec\.ts$/.test(process.argv[1])) {
  const id = process.argv[2];
  // The platform may die while this task runs (its log pipe breaks): keep running, it is re-adopted.
  for (const st of [process.stdout, process.stderr]) st.on('error', () => {});
  execTask(id).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`[task exec] ${(e as Error).stack ?? e}`);
      // Leave the record as it is: the platform sees the exit without a terminal state (63).
      const t = getTask(id);
      if (t && !isTerminal(t.state)) console.error(`[task exec] task ${id} left in ${t.state}`);
      process.exit(1);
    },
  );
}
