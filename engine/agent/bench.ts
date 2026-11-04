// Bench mode (W2-5 P1): the exploration tier on AndroidWorld (ref/android_world, Apache-2.0). Pure: task
// selection, per-task outcome, summary and report. The runner is scripts/bench-aw.ts; the Python service that
// hands out and scores tasks is bench/androidworld/server.py.

/** The pilot set (W2-5 §5.3): 10 tasks, no deletion, no information retrieval. */
export const PILOT_TASKS = [
  'ContactsAddContact',
  'ClockStopWatchRunning',
  'ClockTimerEntry',
  'SystemWifiTurnOff',
  'SystemBrightnessMax',
  'SimpleCalendarAddOneEvent',
  'MarkorCreateNote',
  'ExpenseAddSingle',
  'SimpleSmsSend',
  'CameraTakePhoto',
] as const;

export interface BenchTask {
  name: string;
  instances: number;
  apps: string[];
  complexity: number;
  maxSteps: number;
}

export interface BenchTaskResult {
  name: string;
  idx: number;
  goal: string;
  apps: string[];
  complexity: number;
  maxSteps: number;
  /** AndroidWorld's is_successful (0–1); undefined when the task did not get that far. */
  score?: number;
  /** The agent ended the task itself (done completed / failed). */
  done: boolean;
  /** The task's goal holds in the app's state (AndroidWorld is_successful > 0.5): the success rate counts this. */
  success: boolean;
  /** AndroidWorld's own leaderboard rule: a success only if the agent also ended the task itself. */
  official: boolean;
  status: string;
  steps: number;
  seconds: number;
  modelCalls: number;
  lastThought?: string;
  /** Service or driver error: the task did not run to its score. */
  error?: string;
  runDir: string;
}

/** Pure: the tasks to run — the named ones in the service's order (unknown names are an error), the pilot set,
 *  or all of them. */
export function selectTasks(all: BenchTask[], o: { tasks?: string[]; pilot?: boolean }): BenchTask[] {
  const want = o.tasks?.length ? o.tasks : o.pilot ? [...PILOT_TASKS] : undefined;
  if (!want) return all;
  const unknown = want.filter((n) => !all.some((t) => t.name === n));
  if (unknown.length) throw new Error(`unknown AndroidWorld task(s): ${unknown.join(', ')}`);
  return all.filter((t) => want.includes(t.name));
}

/** Pure: success = the app state checks out (is_successful); official = also ended by the agent itself, as the
 *  AndroidWorld runner counts it (suite_utils._run_task: agent_successful = task_successful if done else 0). */
export function outcome(score: number | undefined, agentStatus: string): { done: boolean; success: boolean; official: boolean } {
  const done = agentStatus === 'completed' || agentStatus === 'failed';
  const success = score !== undefined && score > 0.5;
  return { done, success, official: done && success };
}

export interface BenchSummary {
  tasks: number;
  ran: number;
  errors: number;
  successes: number;
  /** Success rate: successes / all tasks (errors count as failures). */
  rate: number;
  /** AndroidWorld's rule (success and ended by the agent). */
  official: number;
  byApp: Record<string, { tasks: number; successes: number }>;
  byComplexity: Record<string, { tasks: number; successes: number }>;
  steps: number;
  seconds: number;
  modelCalls: number;
}

/** Pure: totals; a task with several apps counts under each of them. */
export function summarize(rs: BenchTaskResult[]): BenchSummary {
  const add = (m: Record<string, { tasks: number; successes: number }>, k: string, ok: boolean) => {
    m[k] ??= { tasks: 0, successes: 0 };
    m[k].tasks++;
    if (ok) m[k].successes++;
  };
  const byApp: BenchSummary['byApp'] = {};
  const byComplexity: BenchSummary['byComplexity'] = {};
  for (const r of rs) {
    for (const a of r.apps.length ? r.apps : ['(none)']) add(byApp, a, r.success);
    add(byComplexity, String(r.complexity), r.success);
  }
  const successes = rs.filter((r) => r.success).length;
  return {
    tasks: rs.length,
    ran: rs.filter((r) => !r.error).length,
    errors: rs.filter((r) => r.error).length,
    successes,
    rate: rs.length ? successes / rs.length : 0,
    official: rs.filter((r) => r.official).length,
    byApp,
    byComplexity,
    steps: rs.reduce((n, r) => n + r.steps, 0),
    seconds: rs.reduce((n, r) => n + r.seconds, 0),
    modelCalls: rs.reduce((n, r) => n + r.modelCalls, 0),
  };
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');

export function benchMarkdown(meta: { seed: number; combos: number; model: string; startedAt: string; budget?: number }, rs: BenchTaskResult[]): string {
  const s = summarize(rs);
  const rows = (m: BenchSummary['byApp']) => Object.entries(m).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([k, v]) => `| ${k} | ${v.successes} / ${v.tasks} | ${pct(v.successes, v.tasks)} |`);
  return [
    `# AndroidWorld 评测：探索档`,
    '',
    `- 成功率：**${s.successes} / ${s.tasks}（${pct(s.successes, s.tasks)}）**（App 状态符合题目要求，AndroidWorld \`is_successful\`）；跑到打分 ${s.ran} 题，出错 ${s.errors} 题（按失败计）`,
    `- AndroidWorld 排行榜口径（还要求 agent 自己结束）：${s.official} / ${s.tasks}（${pct(s.official, s.tasks)}）`,
    `- 题目：seed ${meta.seed}，每题 ${meta.combos} 组参数；步数预算 ${meta.budget ?? 1} × AndroidWorld 预算；模型 ${meta.model || '-'}；开始 ${meta.startedAt}`,
    `- 用量：${s.steps} 步，${Math.round(s.seconds / 60)} 分钟，模型调用 ${s.modelCalls} 次${s.tasks ? `（每题平均 ${(s.modelCalls / s.tasks).toFixed(1)} 次）` : ''}`,

    '',
    '## 按 App',
    '',
    '| App | 成功 | 成功率 |',
    '|---|---|---|',
    ...rows(s.byApp),
    '',
    '## 按难度',
    '',
    '| 难度 | 成功 | 成功率 |',
    '|---|---|---|',
    ...rows(s.byComplexity),
    '',
    '## 逐题',
    '',
    '| 题目 | 成功 | 分数 | agent 结束方式 | 步数 / 预算 | 用时 | 模型调用 | 备注 |',
    '|---|---|---|---|---|---|---|---|',
    ...rs.map((r) => `| ${r.name}#${r.idx} | ${r.success ? '✅' : '❌'} | ${r.score ?? '-'} | ${r.status} | ${r.steps} / ${r.maxSteps} | ${r.seconds} s | ${r.modelCalls} | ${(r.error ?? (r.success ? '' : (r.lastThought ?? ''))).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 120)} |`),
    '',
  ].join('\n');
}
