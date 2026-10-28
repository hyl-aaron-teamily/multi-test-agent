// Series of independent runs (W2-2 §3.4, E2): N cold-started runs of one sub-case, each with its own run
// marker; the summary separates tool reliability (did the run reach the loop?) from the product result
// (reproduced runs, pooled per-round rate with its Wilson interval, or the 3/n bound when nothing hit).
// 环境不合格 runs are listed but not in the reliability denominator (N2).
import { relative } from 'node:path';
import { FAILURE_TEXT } from './failure';
import type { RunResult } from './run';
import { attemptsOf, attemptsText, type Attempts } from './stats';

export interface SeriesRun {
  index: number;
  dir: string;
  result?: RunResult;
  /** The run threw before producing a result (counted as a tool failure). */
  error?: string;
}

export interface SeriesSummary {
  total: number;
  envUnfit: number;
  /** Runs that reached the loop (have attempts) / runs that count (total − 环境不合格). */
  reachedLoop: number;
  counted: number;
  reliability: number;
  failures: { kind: 'env' | 'tool'; rule: string; n: number }[];
  /** Runs with ≥ 1 valid attempt; of those, how many reproduced. */
  validRuns: number;
  reproducedRuns: number;
  pooled: Attempts;
  /** Median phase duration (ms) over the runs that have it. */
  phaseMedians: Record<string, number>;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Pure: the series summary. */
export function summarizeSeries(runs: SeriesRun[]): SeriesSummary {
  const rs = runs.map((r) => r.result);
  const envUnfit = rs.filter((r) => r?.conclusion === '环境不合格').length;
  const counted = runs.length - envUnfit;
  const reached = rs.filter((r) => r?.attempts && r.conclusion !== '环境不合格');
  const reachedLoop = reached.filter((r) => r!.attempts!.valid > 0 || r!.conclusion === '已复现').length;
  const fail = new Map<string, { kind: 'env' | 'tool'; rule: string; n: number }>();
  for (const r of runs) {
    const f = r.result?.failure ?? (r.error ? { kind: 'tool' as const, rule: 'exception', reason: r.error } : r.result && !r.result.attempts?.valid && r.result.conclusion !== '已复现' ? { kind: 'tool' as const, rule: 'no-valid-attempt', reason: '' } : undefined);
    if (!f) continue;
    const k = `${f.kind}:${f.rule}`;
    fail.set(k, { kind: f.kind, rule: f.rule, n: (fail.get(k)?.n ?? 0) + 1 });
  }
  const withAttempts = rs.filter((r) => r?.attempts && r.attempts.valid > 0) as RunResult[];
  const valid = withAttempts.reduce((s, r) => s + r.attempts!.valid, 0);
  const drift = rs.reduce((s, r) => s + (r?.attempts?.drift ?? 0), 0);
  const hits = withAttempts.reduce((s, r) => s + r.attempts!.hits, 0);
  const phases = new Map<string, number[]>();
  for (const r of rs) for (const [k, v] of Object.entries(r?.phases ?? {})) phases.set(k, [...(phases.get(k) ?? []), v]);
  return {
    total: runs.length,
    envUnfit,
    reachedLoop,
    counted,
    reliability: counted ? reachedLoop / counted : 0,
    failures: [...fail.values()].sort((a, b) => b.n - a.n),
    validRuns: withAttempts.length,
    reproducedRuns: withAttempts.filter((r) => r.conclusion === '已复现').length,
    pooled: attemptsOf(valid, drift, hits),
    phaseMedians: Object.fromEntries([...phases].map(([k, v]) => [k, median(v)])),
  };
}

const PHASES = ['lease', 'preflight', 'launch', 'login', 'prepare', 'warmup', 'loop', 'teardown'];
const PHASE_TEXT: Record<string, string> = { lease: '租用', preflight: '预检', launch: '启动', login: '登录', prepare: '准备', warmup: '预热', loop: '循环', teardown: '收尾' };
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Pure: series-report.md. */
export function seriesMarkdown(o: { issue: string; sub: string; surface: string; env: string; runs: SeriesRun[]; dir: string; startedAt: string; finishedAt: string; target?: number }): string {
  const s = summarizeSeries(o.runs);
  const target = o.target ?? 0.9;
  const ok = s.counted > 0 && s.reliability >= target;
  const repro = s.reproducedRuns ? `已复现：${s.reproducedRuns} / ${s.validRuns} 次运行复现` : s.validRuns ? `未复现（本系列 ${s.pooled.valid} 次有效尝试）` : '无有效尝试，无法得出复现结论';
  const lines = [
    `# 系列运行 Issue ${o.issue} / ${o.sub} @ ${o.surface}（${o.env}）— ${repro}`,
    '',
    `- 时间：${o.startedAt} → ${o.finishedAt}；共 ${s.total} 次独立运行（每次冷启动、各自的运行标记）`,
    `- **工具可靠性**：走到循环 ${s.reachedLoop} / ${s.counted}（${pct(s.reliability)}，目标 ≥ ${pct(target)}：${ok ? '达标' : '**未达标**'}）；环境不合格 ${s.envUnfit} 次（列出，不计入分母）`,
    `- 失败归类：${s.failures.length ? s.failures.map((f) => `${FAILURE_TEXT[f.kind]}·${f.rule} ${f.n}`).join('，') : '无'}`,
    `- **复现**：${s.reproducedRuns} / ${s.validRuns} 次有效运行复现；合并单轮：${attemptsText(s.pooled)}`,
    `- 各阶段耗时中位数：${PHASES.filter((p) => s.phaseMedians[p] !== undefined).map((p) => `${PHASE_TEXT[p]} ${(s.phaseMedians[p] / 1000).toFixed(1)}s`).join('，') || '-'}`,
    '',
    '| # | 运行标记 | 结论 | 有效 / 偏离 / 命中 | 失败归类 | App 版本 | 预检 | 耗时 | 报告 |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of o.runs) {
    const x = r.result;
    const m = x?.manifest;
    const a = x?.attempts;
    const link = `${relative(o.dir, r.dir).replace(/\\/g, '/')}/report.md`;
    lines.push(`| ${r.index} | ${x?.runTag ?? '-'} | ${x?.conclusion ?? `异常：${(r.error ?? '').slice(0, 60)}`} | ${a ? `${a.valid} / ${a.drift} / ${a.hits}` : '-'} | ${x?.failure ? `${FAILURE_TEXT[x.failure.kind]}·${x.failure.rule}：${x.failure.reason.slice(0, 80)}` : r.error ? '工具·exception' : '-'} | ${m?.device?.app?.versionName ?? '-'} | ${m?.preflight ? (m.preflight.ok ? `✓ ${m.preflight.ms}ms` : `✗ ${m.preflight.reason}`) : '-'} | ${x?.stats.durationSec ?? '-'}s | [报告](${link}) |`);
  }
  const changes = [...new Set(o.runs.flatMap((r) => r.result?.manifest?.preflight?.changes ?? []))];
  if (changes.length) lines.push('', `预检对手机设置的改动（E3，已记录在各运行清单）：${changes.join('；')}`);
  return lines.join('\n') + '\n';
}
