// W2-3 CLI for agents (§5.3): `autotest <object> <action> [--json]`. A thin client of the platform service
// (/api/v1): it prints the service's envelope — with --json, stdout is exactly one JSON object (anything
// else goes to stderr) — and exits with the envelope's status code (§5.2). Never asks a question.
import { type Code, STATUS } from '../platform/lifecycle/status';

export interface ArgSpec {
  name: string;
  type: 'string' | 'integer' | 'boolean';
  required?: boolean;
  positional?: boolean;
  doc: string;
}
export interface CommandSpec {
  command: string;
  doc: string;
  args: ArgSpec[];
  /** Codes this command can end with (besides 1 / 40 / 54). */
  codes: Code[];
}

const J: ArgSpec = { name: 'json', type: 'boolean', doc: 'stdout = one JSON envelope { status, code, exit, summary, data, error }' };
const PLAN: ArgSpec = { name: 'planId', type: 'string', required: true, positional: true, doc: '<Issue>/<sub>:<surface>@v<draft version>, e.g. 1903/main:android-app@v1' };
const ENV: ArgSpec = { name: 'envId', type: 'string', required: true, positional: true, doc: '<surface>:<device>@<service env>, e.g. android-app:4f2ebdf2@prod' };
const TASK: ArgSpec = { name: 'taskId', type: 'string', required: true, positional: true, doc: 'task id from task run' };

export const COMMANDS: CommandSpec[] = [
  { command: 'help', doc: 'All commands, their arguments and the status-code table', args: [J], codes: ['OK'] },
  { command: 'issue list', doc: 'Issues with category, draft and plan ids / approval state', args: [J], codes: ['OK'] },
  { command: 'issue show', doc: 'One Issue', args: [{ name: 'id', type: 'string', required: true, positional: true, doc: 'Issue id (issues/<id>.md)' }, J], codes: ['OK', 'NOT_FOUND'] },
  { command: 'draft create', doc: 'Draft an Issue anew (may call the model); returns its plan ids', args: [{ name: 'id', type: 'string', required: true, positional: true, doc: 'Issue id' }, { name: 'env', type: 'string', doc: 'test | prod (default prod)' }, { name: 'no-model', type: 'boolean', doc: 'rules only' }, J], codes: ['OK', 'NOT_FOUND'] },
  { command: 'draft show', doc: 'The saved draft with a PlanView per sub-case', args: [{ name: 'id', type: 'string', required: true, positional: true, doc: 'Issue id' }, J], codes: ['OK', 'NOT_FOUND'] },
  { command: 'plan explain', doc: 'Before running: steps, impact, uncertainty, model calls, duration, approval class (PlanView)', args: [PLAN, { name: 'series', type: 'integer', doc: 'series size the approval would be for' }, { name: 'max-rounds', type: 'integer', doc: 'valid attempts per run' }, J], codes: ['OK', 'NOT_FOUND', 'PLAN_STALE', 'PLAN_NOT_EXECUTABLE'] },
  { command: 'plan approve', doc: 'Approve a default-class plan by its hash (sensitive plans: Web only → 30)', args: [PLAN, { name: 'hash', type: 'string', required: true, doc: 'hash from plan explain' }, { name: 'runs', type: 'integer', doc: 'runs allowed (default 1)' }, { name: 'series', type: 'integer', doc: 'series size allowed' }, J], codes: ['OK', 'APPROVAL_REQUIRED', 'PLAN_HASH_MISMATCH', 'PLAN_NOT_EXECUTABLE'] },
  { command: 'plan reject', doc: 'Reject a plan (note required)', args: [PLAN, { name: 'note', type: 'string', required: true, doc: 'why' }, J], codes: ['OK'] },
  { command: 'env list', doc: 'Environments and their state (EnvView)', args: [J], codes: ['OK'] },
  { command: 'env show', doc: 'One environment: last check items, lease, configuration items', args: [ENV, J], codes: ['OK', 'NOT_FOUND'] },
  { command: 'env check', doc: 'Check the environment now (online, unlocked, app version, configuration items) → ready / unfit', args: [ENV, J], codes: ['OK', 'ENV_UNFIT', 'ENV_LOCKED', 'ENV_OFFLINE'] },
  { command: 'task run', doc: 'Submit a plan, or a multi-client sync check (--sync); returns the task id at once (20). Default-class plans are approved by policy. Multi-role plans and --sync lease every environment or none. `task run --explore "<goal>" …` = explore run', args: [{ ...PLAN, required: false, doc: `${PLAN.doc} (or --sync)` }, { name: 'sync', type: 'string', doc: 'multi-client sync check instead of a plan: 2–4 surfaces or environment ids, comma-separated, e.g. desktop-web,android-app (a different pool account each; sends into an allow-listed group)' }, { name: 'rounds', type: 'integer', doc: 'with --sync: rounds (one line sent per round; default one per client)' }, { name: 'env', type: 'string', doc: 'environment id (default: the plan surface’s ready one)' }, { name: 'series', type: 'integer', doc: 'N independent runs' }, { name: 'max-rounds', type: 'integer', doc: 'valid attempts per run' }, { name: 'hash', type: 'string', doc: 'expected plan hash (31 on mismatch)' }, { name: 'dry-run', type: 'boolean', doc: 'check everything, start nothing' }, { name: 'idempotency-key', type: 'string', doc: 'same key → the same task' }, J], codes: ['ACCEPTED', 'OK', 'APPROVAL_REQUIRED', 'PLAN_HASH_MISMATCH', 'PLAN_STALE', 'APPROVAL_EXHAUSTED', 'NOT_FOUND', 'PLAN_NOT_EXECUTABLE', 'ENV_UNFIT', 'ENV_LOCKED', 'ENV_OFFLINE'] },
  { command: 'task status', doc: 'TaskView: state, phase / round / step, how and where it ended, side-effect summary', args: [TASK, J], codes: ['OK', 'NOT_FOUND'] },
  { command: 'task wait', doc: 'Wait until the task ends; exit = its outcome code, 21 when --timeout passes first', args: [TASK, { name: 'timeout', type: 'integer', doc: 'seconds (default 600)' }, J], codes: ['STILL_RUNNING', 'NOT_REPRODUCED', 'REPRODUCED', 'PARTIAL', 'IMPLEMENTED', 'NOT_IMPLEMENTED', 'SUSPECTED_MISOP', 'TURNED_BUG', 'SERIES_DONE', 'PLAN_NOT_EXECUTABLE', 'ENV_UNFIT', 'ENV_LOCKED', 'ENV_OFFLINE', 'TOOL_FAILED', 'SKILL_STALE', 'TASK_CRASHED', 'CANCELLED', 'INTERRUPTED'] },
  { command: 'task cancel', doc: 'Cancel: queued → cancelled; running → stops at the next step boundary (killed if not stopped within 60 s)', args: [TASK, J], codes: ['OK', 'NOT_FOUND', 'BAD_INPUT'] },
  { command: 'task list', doc: 'Recent tasks', args: [{ name: 'limit', type: 'integer', doc: 'default 50' }, J], codes: ['OK'] },
  { command: 'doctor', doc: 'Can runs start, what is missing, what to do next (ready / degraded / blocked; next steps split into commands and things only a person can do). Works with the platform down', args: [{ name: 'fix', type: 'boolean', doc: 'safe local cleanup: stale locks, stale tree-service forwards, leases of dead tasks (never touches the device, never restarts adb)' }, { name: 'probe', type: 'boolean', doc: 'one screenshot + tree read per phone, both backends timed' }, J], codes: ['OK', 'PLATFORM_DOWN', 'ENV_LOCKED', 'ENV_OFFLINE', 'ENV_UNFIT'] },
  { command: 'explore run', doc: 'Exploration tier (capability ②): a goal in plain words, run by the vision agent on a real phone / browser; returns the task id at once (20). Read-only unless --writable (needs full access). result show → findings (each with an incident bundle), coverage, blocked actions, usage', args: [{ name: 'goal', type: 'string', required: true, positional: true, doc: 'what to do or explore, e.g. "看看个人主页的通知铃铛能不能打开"' }, { name: 'mode', type: 'string', doc: 'explore (find problems, default) | task (reach the goal)' }, { name: 'surface', type: 'string', doc: 'android-app (default) | desktop-web | android-web | mobile-web' }, { name: 'env', type: 'string', doc: 'environment id (default: the surface’s ready prod one)' }, { name: 'max-steps', type: 'integer', doc: 'default and hard cap 500' }, { name: 'max-minutes', type: 'integer', doc: 'default and hard cap 30' }, { name: 'writable', type: 'boolean', doc: 'allow sending / editing (full access only; payment, logout, deleting stay blocked)' }, { name: 'dry-run', type: 'boolean', doc: 'check everything, start nothing' }, { name: 'idempotency-key', type: 'string', doc: 'same key → the same task' }, J], codes: ['ACCEPTED', 'OK', 'APPROVAL_REQUIRED', 'NOT_FOUND', 'ENV_UNFIT', 'ENV_LOCKED', 'ENV_OFFLINE'] },
  { command: 'explore issue', doc: 'Exploration finding → Issue draft (issues/explore/<id>.md) for the quick tier: then draft create / plan explain / task run', args: [{ name: 'taskId', type: 'string', required: true, positional: true, doc: 'exploration task id (or its run dir under midscene_run)' }, { name: 'n', type: 'integer', required: true, positional: true, doc: 'finding number from result show' }, J], codes: ['OK', 'NOT_FOUND', 'BAD_INPUT'] },
  { command: 'explore inject', doc: 'Add an instruction to a running exploration task; the agent gets it at the next step boundary (refused once the task has ended)', args: [{ name: 'taskId', type: 'string', required: true, positional: true, doc: 'running exploration task id' }, { name: 'instruction', type: 'string', required: true, positional: true, doc: 'what to do now, in plain words (1–500 characters)' }, J], codes: ['OK', 'NOT_FOUND', 'BAD_INPUT'] },
  { command: 'result show', doc: 'ResultView of a finished task: conclusion sentence, basis, attempts, flags, failure kind, evidence', args: [TASK, J], codes: ['STILL_RUNNING', 'NOT_REPRODUCED', 'REPRODUCED', 'PARTIAL', 'IMPLEMENTED', 'NOT_IMPLEMENTED', 'SERIES_DONE', 'TOOL_FAILED', 'ENV_UNFIT', 'CANCELLED', 'INTERRUPTED', 'TASK_CRASHED'] },
];

export function helpDoc() {
  return {
    schemaVersion: 1,
    usage: 'autotest <object> <action> [args] [--json]',
    notes: ['--json: stdout is exactly one JSON object; logs go to stderr', 'never interactive', 'exit code = envelope.exit (two digits, tens = class); 1 = uncaught tool exception', 'every command except help and doctor needs the platform service (pnpm platform) → else 54', 'sensitive plans / full access / environment configuration items are approved on the Web only'],
    commands: COMMANDS,
    statusCodes: Object.entries(STATUS).map(([code, v]) => ({ exit: v.exit, status: v.status, code, meaning: v.text })),
  };
}

const flag = (a: string[], n: string) => (a.indexOf(`--${n}`) >= 0 ? a[a.indexOf(`--${n}`) + 1] : undefined);
const has = (a: string[], n: string) => a.includes(`--${n}`);
const positional = (a: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      if (!['json', 'dry-run', 'no-model', 'non-interactive', 'all', 'fix', 'probe', 'writable'].includes(a[i].slice(2))) i++;
      continue;
    }
    out.push(a[i]);
  }
  return out;
};

interface Env {
  status: number;
  code: Code;
  exit: number;
  summary: string;
  data?: unknown;
  text?: string;
  error?: { message: string; hint?: string };
}

const BASE = () => `http://localhost:${process.env.PLATFORM_PORT ?? 3210}/api/v1`;

async function call(method: string, path: string, body?: unknown): Promise<Env> {
  try {
    const r = await fetch(`${BASE()}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return (await r.json()) as Env;
  } catch {
    return { status: 503, code: 'PLATFORM_DOWN', exit: 54, summary: '平台服务未启动', error: { message: `连不上 ${BASE()}`, hint: '先启动平台：pnpm platform' } };
  }
}

const enc = encodeURIComponent;
const bad = (m: string): Env => ({ status: 400, code: 'BAD_INPUT', exit: 40, summary: m, error: { message: m, hint: 'autotest help' } });
const int = (v: string | undefined) => (v === undefined ? undefined : Number(v));

const exploreRun = (goal: string, a: string[]) =>
  call('POST', '/tasks', { explore: goal, mode: flag(a, 'mode'), surface: flag(a, 'surface'), envId: flag(a, 'env'), maxSteps: int(flag(a, 'max-steps')), maxMinutes: int(flag(a, 'max-minutes')), writable: has(a, 'writable'), dryRun: has(a, 'dry-run'), idempotencyKey: flag(a, 'idempotency-key') });

export async function dispatch(obj: string, act: string | undefined, a: string[]): Promise<Env> {
  const pos = positional(a);
  const need = (i: number, what: string) => pos[i] ?? (() => { throw new Error(what); })();
  try {
    switch (`${obj} ${act ?? ''}`.trim()) {
      case 'help':
        return { status: 200, code: 'OK', exit: 0, summary: `${COMMANDS.length} 个命令`, data: helpDoc(), text: COMMANDS.map((c) => `autotest ${c.command} ${c.args.map((x) => (x.positional ? `<${x.name}>` : x.required ? `--${x.name} <${x.type}>` : `[--${x.name}${x.type === 'boolean' ? '' : ` <${x.type}>`}]`)).join(' ')}\n    ${c.doc}`).join('\n') + '\n\n状态码：\n' + Object.entries(STATUS).map(([k, v]) => `  ${String(v.exit).padStart(2)} ${String(v.status)} ${k.padEnd(20)} ${v.text}`).join('\n') };
      case 'issue list':
        return call('GET', '/issues');
      case 'issue show':
        return call('GET', `/issues/${enc(need(0, 'issue id'))}`);
      case 'draft create':
        return call('POST', `/drafts/${enc(need(0, 'issue id'))}`, { env: flag(a, 'env') ?? 'prod', model: !has(a, 'no-model') });
      case 'draft show':
        return call('GET', `/drafts/${enc(need(0, 'issue id'))}`);
      case 'plan explain': {
        const qs = new URLSearchParams();
        if (flag(a, 'series')) qs.set('series', flag(a, 'series')!);
        if (flag(a, 'max-rounds')) qs.set('maxRounds', flag(a, 'max-rounds')!);
        return call('GET', `/plans/${enc(need(0, 'planId'))}${qs.size ? `?${qs}` : ''}`);
      }
      case 'plan approve':
        if (!flag(a, 'hash')) return bad('plan approve 需要 --hash <plan explain 给出的哈希>');
        return call('POST', `/plans/${enc(need(0, 'planId'))}/approve`, { hash: flag(a, 'hash'), runs: int(flag(a, 'runs')), series: int(flag(a, 'series')) });
      case 'plan reject':
        return call('POST', `/plans/${enc(need(0, 'planId'))}/reject`, { note: flag(a, 'note') ?? '' });
      case 'env list':
        return call('GET', '/envs');
      case 'env show':
        return call('GET', `/envs/${enc(need(0, 'envId'))}`);
      case 'env check':
        return call('POST', `/envs/${enc(need(0, 'envId'))}/check`);
      case 'task run':
        if (flag(a, 'explore') !== undefined) return exploreRun(flag(a, 'explore')!, a);
        if (flag(a, 'sync') !== undefined) return call('POST', '/tasks', { sync: flag(a, 'sync'), rounds: int(flag(a, 'rounds')), envId: flag(a, 'env'), dryRun: has(a, 'dry-run'), idempotencyKey: flag(a, 'idempotency-key') });
        return call('POST', '/tasks', { planId: need(0, 'planId'), envId: flag(a, 'env'), series: int(flag(a, 'series')), maxRounds: int(flag(a, 'max-rounds')), hash: flag(a, 'hash'), dryRun: has(a, 'dry-run'), idempotencyKey: flag(a, 'idempotency-key') });
      case 'task status':
        return call('GET', `/tasks/${enc(need(0, 'taskId'))}`);
      case 'task cancel':
        return call('POST', `/tasks/${enc(need(0, 'taskId'))}/cancel`);
      case 'task list':
        return call('GET', `/tasks?limit=${int(flag(a, 'limit')) ?? 50}`);
      case 'task wait': {
        const id = need(0, 'taskId');
        const deadline = Date.now() + (int(flag(a, 'timeout')) ?? 600) * 1000;
        for (;;) {
          const left = Math.ceil((deadline - Date.now()) / 1000);
          const r = await call('GET', `/tasks/${enc(id)}/wait?timeout=${Math.max(0, Math.min(20, left))}`);
          if (r.code !== 'STILL_RUNNING' || Date.now() >= deadline) return r;
        }
      }
      case 'explore run':
        return exploreRun(need(0, 'goal'), a);
      case 'explore issue':
        return call('POST', `/explore/${enc(need(0, 'taskId'))}/issue`, { n: Number(need(1, 'finding number')) });
      case 'explore inject':
        return call('POST', `/explore/${enc(need(0, 'taskId'))}/inject`, { text: need(1, 'instruction') });
      case 'result show':
        return call('GET', `/results/${enc(need(0, 'taskId'))}`);
      case 'doctor':
        return doctorLocal(has(a, 'fix'), has(a, 'probe'));
      default:
        return bad(`未知命令：${obj} ${act ?? ''}（autotest help）`);
    }
  } catch (e) {
    return bad(`缺少参数：${(e as Error).message}`);
  }
}

/** `doctor` in this process (it must answer when the platform is down). */
export async function doctorLocal(fix: boolean, probe: boolean): Promise<Env> {
  const { diagnose, doctorText, fixStale, gatherFacts } = await import('../platform/doctor');
  let facts = await gatherFacts({ probe });
  let did: string[] = [];
  if (fix) {
    did = await fixStale(facts);
    if (did.length) facts = await gatherFacts({ probe });
  }
  const d = diagnose(facts);
  const code: Code = d.code;
  const text = `${doctorText(d)}${fix ? `

--fix：${did.length ? did.join('；') : '没有需要清理的残留'}` : ''}`;
  return { status: STATUS[code].status, code, exit: STATUS[code].exit, summary: `${d.conclusion}：${d.summary}`, data: { ...d, ...(fix ? { fixed: did } : {}) }, text };
}

export async function cliV1(obj: string, rest: string[]): Promise<number> {
  const json = rest.includes('--json');
  // JSON mode: stdout carries only the envelope; anything else written to stdout goes to stderr.
  const write = process.stdout.write.bind(process.stdout);
  if (json) (process.stdout as any).write = (chunk: any, ...x: any[]) => process.stderr.write(chunk, ...x);
  const act = obj === 'help' ? undefined : rest.find((x) => !x.startsWith('--'));
  const args = obj === 'help' ? rest : rest.slice(rest.indexOf(act!) + 1);
  const r = await dispatch(obj, act, args);
  if (json) {
    const { text, ...env } = r;
    write(`${JSON.stringify(env)}\n`);
  } else {
    write(`${r.text ?? r.summary}\n`);
    if (r.error) process.stderr.write(`[${r.code} ${r.exit}] ${r.error.message}${r.error.hint ? `\n  提示：${r.error.hint}` : ''}\n`);
  }
  return r.exit;
}
