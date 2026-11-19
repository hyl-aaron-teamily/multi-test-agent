// Judging one exploration finding (W3-4 §8.5 ③④): its known-issue key, D10, the known issues, its state in
// words. Pure (the caller reads and writes platform/explore/known.json); the platform uses it without loading the
// executor.
import type { Finding } from '../agent/run';
import type { StepRecord } from '../agent/step';
import { UNKNOWN_PAGE } from '../pages';
import { D10_REASON, dismissed, inputNotCommittedBefore, type KnownIssue, matchKnown, recordKnown, TRIAGE_TEXT } from './known';

/** Pure: the known-issue key parts of a finding (W3-4 §8.5 ④). */
export function findingKey(f: Pick<Finding, 'source' | 'kind' | 'detector' | 'text' | 'description' | 'expectation' | 'page'>): { page: string; type: string; text: string } {
  const page = f.page ?? UNKNOWN_PAGE;
  if (f.source === 'detector') return { page, type: f.detector ?? 'detector', text: f.text ?? f.description };
  if (f.source === 'expectation') return { page, type: `expectation:${f.expectation?.id ?? ''}`, text: f.expectation?.id ?? f.description };
  if (f.source === 'hard') return { page, type: `hard:${f.kind}`, text: f.description };
  return { page, type: f.source, text: f.description };
}

/** Pure on `known` (mutated): D10 first — a "typed text does not show" report after `input not committed` does not
 *  count; then the known issues — a dismissed one does not count again, a counted finding bumps the issue it is
 *  (or becomes a new one), an uncounted one is only linked. */
export function judgeFinding(f: Finding, steps: Pick<StepRecord, 'step' | 'readback'>[], known: KnownIssue[], run: string, at = new Date().toISOString()): void {
  if ((f.source === 'reported' || f.source === 'expectation') && inputNotCommittedBefore(steps, f.step, f.description)) {
    f.counted = false;
    f.excluded = D10_REASON;
    return;
  }
  const key = findingKey(f);
  const k = matchKnown(known, key);
  if (k && dismissed(k)) {
    f.counted = false;
    f.excluded = `已知问题 ${k.id} 已被人工标注为「${TRIAGE_TEXT[k.triage!.verdict]}」`;
    f.known = { id: k.id, count: k.count, isNew: false };
    return;
  }
  if (!f.counted) {
    if (k) f.known = { id: k.id, count: k.count, isNew: false };
    return;
  }
  const r = recordKnown(known, { ...key, description: f.description }, { run, n: f.n, at });
  f.known = { id: r.issue.id, count: r.issue.count, isNew: r.isNew };
}

/** Pure: the finding's state in words (counted / known again / excluded / triaged). */
export function findingState(f: Finding): string {
  if (f.triage) return `人工标注：${TRIAGE_TEXT[f.triage.verdict]}${f.triage.note ? `（${f.triage.note}）` : ''}`;
  if (f.excluded) return `不计入：${f.excluded}`;
  if (!f.counted) return '未计入';
  return f.known && !f.known.isNew ? `已知问题 ${f.known.id}（累计 ${f.known.count} 次）` : f.known ? `新问题 ${f.known.id}` : '计入';
}

/** How a finding was found, for people. */
export const FINDING_SOURCE: Record<Finding['source'], string> = { hard: '硬异常', reported: '模型报告', detector: '确定性判定', expectation: '预期核对', human: '人工' };
