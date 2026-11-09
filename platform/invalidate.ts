// W3-1 P0: a result whose plan did not match its Issue is marked invalid (result.json `invalidated`, shown on
// the result page and in the report), and a draft built by such a rule template is marked for rewrite
// (`stale`: its plans no longer resolve). Both are explicit records, never silent deletions.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRAFTS_DIR } from '../issue/drafts';
import type { Draft } from '../issue/planner';
import { CodedError } from './lifecycle/status';
import { writeJsonAtomic } from './lifecycle/store';
import { getTask, listTasks, readResult, writeResult } from './lifecycle/task';

export interface Invalidation {
  reason: string;
  at: string;
  by: string;
}

/** Mark a finished task's result invalid. */
export function invalidateResult(taskId: string, reason: string, by: string): Invalidation {
  const t = getTask(taskId);
  if (!t) throw new CodedError('NOT_FOUND', `没有任务 ${taskId}`);
  const r = readResult<Record<string, unknown>>(taskId);
  if (!r) throw new CodedError('NOT_FOUND', `任务 ${taskId} 还没有结果`);
  if (!reason.trim()) throw new CodedError('BAD_INPUT', '作废需要写明原因（--reason）');
  const inv: Invalidation = { reason: reason.trim(), at: new Date().toISOString(), by };
  writeResult(taskId, { ...r, invalidated: inv });
  return inv;
}

/** Mark a saved draft for rewrite: its plans stop resolving until the Issue is drafted again. */
export function markDraftStale(issue: string, reason: string, dir = DRAFTS_DIR): Draft | undefined {
  const f = join(dir, `${issue}.json`);
  if (!existsSync(f)) return undefined;
  const d = JSON.parse(readFileSync(f, 'utf8')) as Draft;
  d.stale = { reason, at: new Date().toISOString() };
  writeJsonAtomic(f, d);
  return d;
}

/** Task ids of an Issue's finished runs (top-level tasks). */
export const tasksOfIssue = (issue: string) => listTasks().filter((t) => t.issue === issue && !t.parent && t.kind !== 'explore').map((t) => t.id);
