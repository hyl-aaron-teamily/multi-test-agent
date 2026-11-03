// `autotest bench aw` — the exploration tier on AndroidWorld (W2-5 P1). Needs the bench service running
// (bench/androidworld/server.py, docs/env-plan.md) and the AndroidWorld emulator.
//   pnpm autotest bench aw [--pilot | --tasks A,B] [--udid emulator-5554] [--server http://127.0.0.1:5055]
//        [--resume <run dir>] [--seed 42] [--combos 1]
// --seed / --combos only label the report: the service builds the task set (its own --seed / --combos).
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type BenchTask, type BenchTaskResult, benchMarkdown, outcome, selectTasks, summarize } from '../engine/agent/bench';
import { runAgent } from '../engine/agent/run';
import { isEmulator } from '../engine/session';

const flag = (a: string[], k: string) => {
  const i = a.indexOf(`--${k}`);
  return i >= 0 ? a[i + 1] : undefined;
};

/** Stop after this many tasks in a row end in a service / driver error (the emulator or the service is gone). */
const MAX_ERRORS_IN_A_ROW = 3;

export async function benchCmd(args: string[]): Promise<number> {
  if (args[0] !== 'aw') {
    console.error('Usage: autotest bench aw [--pilot | --tasks A,B] [--udid emulator-5554] [--server http://127.0.0.1:5055] [--resume <run dir>] [--seed 42] [--combos 1]');
    return 40;
  }
  const server = (flag(args, 'server') ?? 'http://127.0.0.1:5055').replace(/\/$/, '');
  const udid = flag(args, 'udid') ?? 'emulator-5554';
  if (!isEmulator(udid)) {
    console.error(`bench mode runs only on an emulator (emulator-<port>), not on ${udid}`);
    return 40;
  }
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${server}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(600_000) });
    if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  };
  try {
    await call('GET', '/health');
  } catch (e) {
    console.error(`bench service not reachable at ${server} (${(e as Error).message}) — start bench/androidworld/server.py first`);
    return 50;
  }
  const all = (await call<{ tasks: BenchTask[] }>('GET', '/tasks')).tasks;
  let picked: BenchTask[];
  try {
    picked = selectTasks(all, { tasks: flag(args, 'tasks')?.split(',').map((s) => s.trim()).filter(Boolean), pilot: args.includes('--pilot') });
  } catch (e) {
    console.error((e as Error).message);
    return 40;
  }
  const root = resolve(flag(args, 'resume') ?? join('midscene_run/bench', `aw-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  await mkdir(root, { recursive: true });
  const meta = { seed: Number(flag(args, 'seed') ?? 42), combos: Number(flag(args, 'combos') ?? 1), model: process.env.MIDSCENE_MODEL_NAME ?? '', startedAt: new Date().toISOString() };
  const results: BenchTaskResult[] = [];
  const save = async () => {
    await writeFile(join(root, 'summary.json'), JSON.stringify({ ...meta, summary: summarize(results), results }, null, 2));
    await writeFile(join(root, 'report.md'), benchMarkdown(meta, results));
  };
  let errorsInARow = 0;
  for (const t of picked) {
    for (let idx = 0; idx < t.instances; idx++) {
      const dir = join(root, `${t.name}-${idx}`);
      const file = join(dir, 'bench.json');
      if (existsSync(file)) {
        results.push(JSON.parse(readFileSync(file, 'utf8')) as BenchTaskResult);
        continue;
      }
      const q = `name=${encodeURIComponent(t.name)}&idx=${idx}`;
      const r: BenchTaskResult = { name: t.name, idx, goal: '', apps: t.apps, complexity: t.complexity, maxSteps: t.maxSteps, done: false, success: false, status: 'error', steps: 0, seconds: 0, modelCalls: 0, runDir: dir };
      try {
        const init = await call<{ goal: string; maxSteps: number }>('POST', `/task/init?${q}`);
        r.goal = init.goal;
        r.maxSteps = init.maxSteps;
        console.log(`[bench] ${t.name}#${idx} (${init.maxSteps} steps): ${init.goal}`);
        const a = await runAgent({
          goal: init.goal,
          mode: 'task',
          surface: 'android-app',
          env: 'test',
          writable: true,
          maxSteps: init.maxSteps,
          maxMinutes: 30,
          runDir: dir,
          bench: { udid, act: async (body) => void (await call('POST', '/action', body)) },
        });
        Object.assign(r, { status: a.status, steps: a.usage.steps, seconds: a.usage.seconds, modelCalls: a.usage.modelCalls, lastThought: a.steps.at(-1)?.thought });
        if (a.status === 'error') r.error = a.error ?? a.summary;
        else r.score = (await call<{ score: number }>('GET', `/task/score?${q}`)).score;
      } catch (e) {
        r.error = (e as Error).message.split('\n')[0].slice(0, 200);
      }
      await call('POST', `/task/teardown?${q}`).catch((e) => console.error(`[bench] teardown ${t.name}#${idx}: ${(e as Error).message}`));
      Object.assign(r, outcome(r.score, r.status));
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(r, null, 2));
      results.push(r);
      await save();
      console.log(`[bench] ${t.name}#${idx}: ${r.success ? 'success' : 'fail'} (score ${r.score ?? '-'}, ${r.status}, ${r.steps} steps, ${r.seconds} s)${r.error ? ` — ${r.error}` : ''}`);
      errorsInARow = r.error ? errorsInARow + 1 : 0;
      if (errorsInARow >= MAX_ERRORS_IN_A_ROW) {
        console.error(`[bench] ${MAX_ERRORS_IN_A_ROW} tasks in a row ended in an error — stopping (check the emulator and the service; --resume ${root} continues)`);
        await save();
        return 50;
      }
    }
  }
  await save();
  const s = summarize(results);
  console.log(`[bench] ${s.successes}/${s.tasks} tasks (${(100 * s.rate).toFixed(1)}%), ${s.errors} errors, ${s.modelCalls} model calls → ${join(root, 'report.md')}`);
  return 0;
}

if (process.argv[1] && /bench-aw\.ts$/.test(process.argv[1])) benchCmd(process.argv.slice(2)).then((c) => process.exit(c));
