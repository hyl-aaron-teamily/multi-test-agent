// /api/v1/issues/:id/… of the plan record (W3-6 §6.3): the record, patches (a person's edit, a change applied from
// the side chat), rollback, the diff of two revs, the runs grouped by rev, and the side chat (§7, D3: the model
// suggests, a person applies). The execute button (POST /issues/:id/run) lives in api-v1.ts next to `submit`.
import { readFileSync } from 'node:fs';
import { modelCall } from '../core/context/assemble';
import { modelConfigured } from '../core/model/llm';
import { systemSlots } from '../issue/author';
import { saveRecord } from '../issue/drafts';
import { issuePath } from '../issue/paths';
import { asRecord, type ChatEntry, compileRecord, contextOf, diffRevs, type PatchOp, patchRecord, type PlanRecord, revOf, rollbackRecord, stateOf } from '../issue/record';
import { apiError, type Code, outcome } from './lifecycle/status';
import { listTasks, readResult, type TaskRecord } from './lifecycle/task';
import { savedDraft } from './plans-v1';
import type { Envelope } from './api-v1';

const ok = (code: Code, summary: string, data?: unknown, text?: string): Envelope => ({ ...outcome(code), summary, data, text });
const fail = (code: Code, message: string, hint?: string): Envelope => ({ ...outcome(code), summary: message, error: apiError(code, message, hint) });

export function loadRecord(id: string): PlanRecord | undefined {
  const d = savedDraft(id);
  if (!d) return undefined;
  const r = asRecord(d);
  // A draft from before W3-6 kept no errors by path: compile its delivery again to show them (same rev).
  if (r.status !== 'plannable' && r.envelope && !r.partial && !r.gaps) {
    try {
      const f = compileRecord(r, r.envelope, contextOf(r, revOf(r)));
      if (f.status !== 'plannable') Object.assign(r, { partial: f.partial, gaps: f.gaps });
    } catch {
      /* the Issue file is gone: show what is there */
    }
  }
  return r;
}

/** Pure: the rev a task ran (from its plan id `…@v<rev>`). */
export const taskRev = (t: Pick<TaskRecord, 'planId'>) => Number(t.planId.match(/@v(\d+)$/)?.[1] ?? 0);

/** Runs of an Issue, grouped by rev; one execution (the button pressed once) = one row, its sub-case tasks inside. */
export function issueRuns(id: string): { rev: number; runs: { batch: string; at: string; tasks: { id: string; planId: string; state: string; summary?: string; code?: string }[] }[] }[] {
  const tasks = listTasks().filter((t) => t.issue === id && t.kind !== 'explore' && !t.parent);
  const byRev = new Map<number, Map<string, TaskRecord[]>>();
  for (const t of tasks) {
    const rev = taskRev(t);
    const key = t.batch ?? t.id;
    const m = byRev.get(rev) ?? new Map<string, TaskRecord[]>();
    m.set(key, [...(m.get(key) ?? []), t]);
    byRev.set(rev, m);
  }
  return [...byRev.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rev, m]) => ({
      rev,
      runs: [...m.entries()]
        .map(([batch, ts]) => ({ batch, at: ts.map((t) => t.createdAt).sort()[0], tasks: ts.map((t) => ({ id: t.id, planId: t.planId, state: t.state, summary: t.outcome?.summary, code: t.outcome?.code })) }))
        .sort((a, b) => b.at.localeCompare(a.at)),
    }));
}

/** The record as the Issue page shows it (snapshots left out: diff / rollback fetch them). */
export function recordView(r: PlanRecord) {
  const rec = asRecord(r);
  return {
    issue: rec.issue.id,
    title: rec.issue.title,
    rev: revOf(rec),
    state: stateOf(rec),
    status: rec.status,
    reason: rec.reason,
    hash: rec.hash,
    understanding: rec.envelope?.understanding,
    feasibility: rec.envelope?.feasibility,
    quotes: rec.envelope?.quotes,
    subcases: rec.subcases.map((s) => ({ sub: s.sub, title: s.title, surface: s.surface, plan: s.plan, oracle: rec.envelope?.subcases.find((x) => x.sub === s.sub)?.oracle })),
    partial: rec.partial ?? [],
    gaps: rec.gaps ?? [],
    envelope: rec.envelope,
    revs: (rec.revs ?? []).map(({ snapshot, ...x }) => ({ ...x, status: snapshot.status })),
    chat: rec.chat ?? [],
    runs: issueRuns(rec.issue.id),
  };
}

export function getRecord(id: string): Envelope {
  const r = loadRecord(id);
  if (!r) return fail('NOT_FOUND', `Issue ${id} 还没有计划`, `autotest draft create ${id}`);
  const v = recordView(r);
  return ok('OK', `Issue ${id} 计划 rev ${v.rev}（${v.state}）：${v.reason.slice(0, 160)}`, v, [`Issue ${id} · rev ${v.rev} · ${v.state}`, v.reason, ...v.partial.flatMap((p) => p.errors.map((e) => `  ✗ ${e.path}：${e.message}`)), ...v.gaps.map((g) => `  缺 ${g.kind}：${g.need}`), ...v.revs.map((x) => `  rev ${x.rev} ${x.source} ${x.at.slice(0, 16)} ${x.reason}${x.paths.length ? `（${x.paths.join('、')}）` : ''}`)].join('\n'));
}

/** PATCH /issues/:id/plan {ops, reason, source?} — a person's edit (D2) or a change applied from the chat. */
export async function patchPlan(id: string, b: any, by: string): Promise<Envelope> {
  const r = loadRecord(id);
  if (!r) return fail('NOT_FOUND', `Issue ${id} 还没有计划`);
  const ops = (Array.isArray(b.ops) ? b.ops : []) as PatchOp[];
  const source = b.source === 'chat' ? 'chat' : 'human';
  try {
    const next = patchRecord(r, ops, { source, reason: String(b.reason ?? ''), by });
    await saveRecord(next);
    const v = recordView(next);
    return ok('OK', `rev ${v.rev}（${v.state}）：${ops.length} 处修改${v.partial.length ? `；仍有 ${v.partial.reduce((n, p) => n + p.errors.length, 0)} 处错误` : ''}`, v);
  } catch (e) {
    return fail('BAD_INPUT', (e as Error).message);
  }
}

export async function rollbackPlan(id: string, b: any, by: string): Promise<Envelope> {
  const r = loadRecord(id);
  if (!r) return fail('NOT_FOUND', `Issue ${id} 还没有计划`);
  try {
    const next = rollbackRecord(r, Number(b.rev), { by });
    await saveRecord(next);
    return ok('OK', `已回退：rev ${b.rev} 的内容成为 rev ${revOf(next)}（${stateOf(next)}）`, recordView(next));
  } catch (e) {
    return fail('BAD_INPUT', (e as Error).message);
  }
}

export function diffPlan(id: string, a: number, b: number): Envelope {
  const r = loadRecord(id);
  if (!r) return fail('NOT_FOUND', `Issue ${id} 还没有计划`);
  try {
    const d = diffRevs(r, a, b);
    return ok('OK', `rev ${a} → rev ${b}：${d.changes.length} 处不同`, d, d.changes.map((c) => `${c.path}\n  - ${JSON.stringify(c.a)}\n  + ${JSON.stringify(c.b)}`).join('\n'));
  } catch (e) {
    return fail('BAD_INPUT', (e as Error).message);
  }
}

// ---------------------------------------------------------------- side chat (§7)

const CHAT_SYSTEM = `You help a tester improve the test plan of one Issue. The plan is the JSON "envelope" below (quotes,
understanding, feasibility, subcases[].plan built from the SKILL blocks). Answer with ONE JSON object:
{"reply": "<Chinese, short: what you think and why>", "ops": [{"op":"replace|add|remove","path":"/subcases/<sub>/plan/...","value":...}]}
"ops" is optional: give it only when you propose a concrete change. Paths are JSON pointers into the envelope; a
sub-case is addressed by its name. Never touch executor fields (id, issueRef, category, surface, env, limits,
verdictRule, provenance, issueSurfaces, audit, contract, coverage, substitution). Keep the hard rules: messages
only into allow-listed conversations, no credentials, no deleting / recalling.`;

/** Pure: the user message of one chat turn (Issue, plan, the latest run's failure, the conversation so far). */
export function chatPrompt(r: PlanRecord, raw: string, message: string, lastRun?: string): string {
  return [
    `# Issue ${r.issue.id}（原文）`,
    raw,
    '',
    `# 当前计划（rev ${revOf(r)}，${stateOf(r)}）`,
    JSON.stringify(r.envelope ?? {}),
    ...(r.partial?.length ? ['', '# 校验错误（按路径）', ...r.partial.flatMap((p) => p.errors.map((e) => `- ${e.path}：${e.message}`))] : []),
    ...(lastRun ? ['', '# 最近一次运行', lastRun] : []),
    ...((r.chat ?? []).length ? ['', '# 之前的对话', ...(r.chat ?? []).slice(-8).map((c) => `${c.role === 'user' ? '测试者' : '你'}：${c.text}`)] : []),
    '',
    `# 测试者现在说`,
    message,
  ].join('\n');
}

function lastRunText(id: string): string | undefined {
  const t = listTasks().filter((x) => x.issue === id && x.outcome).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!t) return undefined;
  const res = readResult<any>(t.id);
  const run = res?.runs?.at(-1);
  return [`任务 ${t.id}（${t.planId}）：${t.outcome?.code} — ${t.outcome?.summary ?? ''}`, run?.failure ? `失败：${JSON.stringify(run.failure).slice(0, 600)}` : '', run?.warmup ? `预热：${JSON.stringify(run.warmup).slice(0, 800)}` : ''].filter(Boolean).join('\n');
}

export async function chat(id: string, b: any): Promise<Envelope> {
  const r = loadRecord(id);
  if (!r) return fail('NOT_FOUND', `Issue ${id} 还没有计划`);
  const message = String(b.message ?? '').trim();
  if (!message) return fail('BAD_INPUT', '说点什么');
  if (!modelConfigured()) return fail('PLAN_NOT_EXECUTABLE', '没有配置模型，不能对话');
  const raw = readFileSync(issuePath(id), 'utf8');
  const res = await modelCall({ purpose: 'plan-chat', slots: [...systemSlots(), { name: 'chat-role', role: 'system', stable: true, content: CHAT_SYSTEM }, { name: 'chat', role: 'user', content: chatPrompt(r, raw, message, lastRunText(id)) }], correct: true, timeoutMs: 180_000 });
  const at = new Date().toISOString();
  const v = (res.ok ? res.value : {}) as { reply?: string; ops?: PatchOp[] };
  const reply: ChatEntry = { role: 'model', text: String(v.reply ?? (res.ok ? '' : `（模型没有回答：${res.error.slice(0, 160)}）`)), at, rev: revOf(r), ...(Array.isArray(v.ops) && v.ops.length ? { ops: v.ops } : {}) };
  // A suggestion is checked now (not saved): the person sees whether it would pass.
  let check: string | undefined;
  if (reply.ops) {
    try {
      const trial = patchRecord(r, reply.ops, { source: 'chat', reason: 'trial' });
      check = trial.status === 'plannable' ? '应用后可运行' : `应用后仍是「${stateOf(trial)}」：${trial.reason.slice(0, 200)}`;
    } catch (e) {
      check = `这个修改不能应用：${(e as Error).message}`;
    }
  }
  r.chat = [...(r.chat ?? []), { role: 'user', text: message, at, rev: revOf(r) }, reply];
  await saveRecord(r);
  return ok('OK', reply.text.slice(0, 200) || '（空回答）', { reply, check, n: r.chat.length - 1 });
}

/** Apply the suggestion of chat entry n (D3). */
export async function applyChat(id: string, n: number, by: string): Promise<Envelope> {
  const r = loadRecord(id);
  if (!r) return fail('NOT_FOUND', `Issue ${id} 还没有计划`);
  const c = r.chat?.[n];
  if (!c?.ops?.length) return fail('BAD_INPUT', `对话第 ${n} 条没有建议修改`);
  if (c.applied) return fail('BAD_INPUT', `对话第 ${n} 条已应用为 rev ${c.applied}`);
  try {
    const next = patchRecord(r, c.ops, { source: 'chat', reason: `对话建议：${c.text.slice(0, 80)}`, by });
    next.chat![n] = { ...c, applied: revOf(next) };
    await saveRecord(next);
    return ok('OK', `已应用：rev ${revOf(next)}（${stateOf(next)}）`, recordView(next));
  } catch (e) {
    return fail('BAD_INPUT', (e as Error).message);
  }
}
