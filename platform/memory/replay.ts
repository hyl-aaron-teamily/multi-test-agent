// Offline replay (W3-5 §8.8): the judging of past runs again, without a device — which findings would count
// with the repository's lessons and which without, against people's labels. The gate of a new lesson (§8.7 ③,
// D12): a lesson that would hide a finding people confirmed as a real problem does not go live.
// Deterministic: only the repository's lessons (the matching path), no model, no memory service.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { type FindingFacts, type Lesson, type StepContext, suppressingLesson } from './lessons';

export type Label = 'issue' | 'not-issue' | 'env';

export interface ReplayStep {
  step: number;
  action: string;
  readback?: string[];
  page?: string;
}

export interface ReplayFinding {
  n: number;
  source: string;
  /** Known-issue type (engine/explore/judge#findingKey). */
  type: string;
  text: string;
  page?: string;
  knownId?: string;
  step: number;
  /** Counted before any lesson (counted, or hidden only by a lesson). */
  base: boolean;
  label?: Label;
}

export interface ReplayRun {
  run: string;
  surface: string;
  steps: ReplayStep[];
  findings: ReplayFinding[];
}

export interface ReplayRow {
  run: string;
  n: number;
  label?: Label;
  before: boolean;
  after: boolean;
  lesson?: string;
}

export interface ReplayReport {
  rows: ReplayRow[];
  /** Counted without lessons. */
  before: { counted: number; falsePositives: number; truePositives: number };
  after: { counted: number; falsePositives: number; truePositives: number };
  /** Labelled not-issue / env, counted before, not after. */
  removedFalse: ReplayRow[];
  /** Labelled issue, counted before, hidden after — a gate failure. */
  hiddenTrue: ReplayRow[];
}

/** Pure: the action type of a step record's action text ("type #3 …" → type). */
export const actionType = (action: string) => action.trim().match(/^([a-z_]+)/i)?.[1]?.toLowerCase();

/** Pure: what the executor knew when a finding of step `step` was judged (previous action, read-back). */
export function contextAt(run: Pick<ReplayRun, 'surface' | 'steps'>, step: number, page?: string): StepContext {
  const prev = [...run.steps].filter((s) => s.step <= step).sort((a, b) => b.step - a.step);
  const last = prev[0];
  return { surface: run.surface, page: page ?? last?.page, lastAction: last ? actionType(last.action) : undefined, readback: prev.find((s) => s.readback?.length)?.readback };
}

/** Pure: replay findings with these lessons. */
export function replay(runs: ReplayRun[], lessons: Lesson[]): ReplayReport {
  const rows: ReplayRow[] = [];
  for (const r of runs) {
    for (const f of r.findings) {
      const facts: FindingFacts = { source: f.source, type: f.type, text: f.text, page: f.page, knownId: f.knownId, step: f.step };
      const l = f.base ? suppressingLesson(lessons, facts, contextAt(r, f.step, f.page)) : undefined;
      rows.push({ run: r.run, n: f.n, label: f.label, before: f.base, after: f.base && !l, ...(l ? { lesson: l.id } : {}) });
    }
  }
  const tally = (k: 'before' | 'after') => ({
    counted: rows.filter((x) => x[k]).length,
    falsePositives: rows.filter((x) => x[k] && (x.label === 'not-issue' || x.label === 'env')).length,
    truePositives: rows.filter((x) => x[k] && x.label === 'issue').length,
  });
  return {
    rows,
    before: tally('before'),
    after: tally('after'),
    removedFalse: rows.filter((x) => x.before && !x.after && (x.label === 'not-issue' || x.label === 'env')),
    hiddenTrue: rows.filter((x) => x.before && !x.after && x.label === 'issue'),
  };
}

/** Pure: the gate of one lesson — what it changes alone, and whether it hides a confirmed problem. */
export function gate(lesson: Lesson, runs: ReplayRun[]): { ok: boolean; removedFalse: ReplayRow[]; hiddenTrue: ReplayRow[]; changed: ReplayRow[] } {
  const r = replay(runs, [{ ...lesson, status: 'active' }]);
  const changed = r.rows.filter((x) => x.before !== x.after);
  return { ok: !r.hiddenTrue.length, removedFalse: r.removedFalse, hiddenTrue: r.hiddenTrue, changed };
}

export function reportText(r: ReplayReport): string {
  return [
    `没有教训：计入 ${r.before.counted}（误报 ${r.before.falsePositives}，真问题 ${r.before.truePositives}）`,
    `有教训：  计入 ${r.after.counted}（误报 ${r.after.falsePositives}，真问题 ${r.after.truePositives}）`,
    `撤销误报 ${r.removedFalse.length}：${r.removedFalse.map((x) => `${x.run}#${x.n}←${x.lesson}`).join('，') || '-'}`,
    `压掉真问题 ${r.hiddenTrue.length}：${r.hiddenTrue.map((x) => `${x.run}#${x.n}←${x.lesson}`).join('，') || '-'}`,
  ].join('\n');
}

// ---------------------------------------------------------------- data set

/** A finding / step of an exploration result (engine/agent/run AgentResult), loosely typed: replay reads old runs. */
type AnyResult = { surface?: string; runDir?: string; steps?: any[]; findings?: any[] };
type TriageLike = { run: string; n?: number; verdict: Label };

/** Pure: a run of the data set from an exploration result and the triage marks on it. */
export function runOf(run: string, r: AnyResult, triage: TriageLike[] = []): ReplayRun {
  const typeOf = (f: any): string => (f.source === 'detector' ? (f.detector ?? 'detector') : f.source === 'expectation' ? `expectation:${f.expectation?.id ?? ''}` : f.source === 'hard' ? `hard:${f.kind}` : f.source);
  return {
    run,
    surface: r.surface ?? 'android-app',
    steps: (r.steps ?? []).map((s) => ({ step: s.step, action: s.action ?? '', ...(s.readback ? { readback: s.readback } : {}), ...(s.page ? { page: s.page } : {}) })),
    findings: (r.findings ?? []).map((f) => {
      const label = (f.triage?.verdict ?? triage.find((t) => t.run === run && t.n === f.n)?.verdict) as Label | undefined;
      return { n: f.n, source: f.source, type: typeOf(f), text: f.source === 'detector' ? (f.text ?? f.description) : f.description, ...(f.page ? { page: f.page } : {}), ...(f.known?.id ? { knownId: f.known.id } : {}), step: f.step, base: !!f.counted || !!f.lesson, ...(label ? { label } : {}) };
    }),
  };
}

export const replayDir = () => resolve(process.env.AUTOTEST_REPLAY_DIR ?? 'fixtures/replay');

/** The data set: fixtures/replay/*.json (exported runs; *.local.json stay out of git). */
export function readDataset(dir = replayDir()): ReplayRun[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ReplayRun | { runs: ReplayRun[] };
      return 'runs' in j ? j.runs : [j];
    } catch {
      return [];
    }
  });
}

/** Export a run (with its labels) into the data set. Texts only — no screenshots, no paths. */
export function exportRun(r: ReplayRun, dir = replayDir()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${basename(r.run).replace(/[^\w.-]/g, '_')}.local.json`);
  writeFileSync(file, JSON.stringify(r, null, 2));
  return file;
}
