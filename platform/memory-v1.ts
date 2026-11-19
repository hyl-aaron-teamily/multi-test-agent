// /api/v1/memory/… (W3-5): lessons (list, learn from a mark, edit, disable / enable, undo, confirm a candidate),
// candidates from the memory service (D14: always confirmed by a person this milestone), the replay report,
// and the memory service's state.
import { memoryClient, memoryUser } from '../core/memory/client';
import type { AgentResult } from '../engine/agent/run';
import { readTriage } from '../engine/explore/known';
import { apiError, type Code, outcome } from './lifecycle/status';
import { getTask, readResult } from './lifecycle/task';
import { learn } from './memory/learn';
import { checkLesson, type Lesson, lessonText, readLessons, readStats, updateLessons } from './memory/lessons';
import { gate, reportText, replay } from './memory/replay';
import { gateRuns } from './memory/learn';
import type { Envelope } from './api-v1';

const ok = (code: Code, summary: string, data?: unknown, text?: string): Envelope => ({ ...outcome(code), summary, data, text });
const fail = (code: Code, message: string, hint?: string): Envelope => ({ ...outcome(code), summary: message, error: apiError(code, message, hint) });

export function listLessons(status?: string): Envelope {
  const stats = readStats();
  const items = readLessons().filter((l) => !status || l.status === status);
  return ok('OK', `${items.length} 条教训（生效 ${items.filter((l) => l.status === 'active').length}，候选 ${items.filter((l) => l.status === 'candidate').length}）`, items.map((l) => ({ ...l, stats: stats[l.id] })), items.map((l) => lessonText(l, stats[l.id])).join('\n') || '还没有教训');
}

/** A mark with a sentence → a lesson (the explore result page calls this right after 「不是问题 / 环境问题」). */
export async function learnFromMark(b: any): Promise<Envelope> {
  const taskId = String(b.task ?? '');
  const t = getTask(taskId);
  if (!t || t.kind !== 'explore') return fail('NOT_FOUND', `没有探索任务 ${taskId}`);
  const r = readResult<{ agent?: AgentResult }>(taskId)?.agent;
  if (!r) return fail('BAD_INPUT', `任务 ${taskId} 还没有结果`);
  const f = r.findings.find((x) => x.n === Number(b.n));
  if (!f) return fail('NOT_FOUND', `任务 ${taskId} 没有发现 #${b.n}`);
  const note = String(b.note ?? f.triage?.note ?? '').trim();
  if (!note) return fail('BAD_INPUT', '写一句话说明为什么不是问题（例如「未输入」）');
  const verdict = (b.verdict ?? f.triage?.verdict) === 'env' ? 'env' : 'not-issue';
  const o = await learn({ run: taskId, result: r, finding: f, note, verdict }, { useModel: b.useModel !== false });
  const l = o.lesson;
  return ok('OK', `${l.status === 'active' ? '教训已生效' : '教训待确认'}：${l.id}（${o.how === 'model' ? '模型提炼' : '按规则'}；回放撤销误报 ${o.removedFalse} 个${o.hiddenTrue.length ? `，会压掉真问题 ${o.hiddenTrue.length} 个` : ''}${o.synced ? '；已同步到记忆服务' : '；记忆服务未同步'}）`, o, `${lessonText(l)}\n预览：${l.preview}`);
}

const STATUS_FOR: Record<string, Lesson['status']> = { disable: 'disabled', enable: 'active', undo: 'undone', confirm: 'active' };

/** disable / enable / undo / confirm (a candidate goes live after the gate passes). */
export async function setLessonStatus(id: string, action: string, by: string): Promise<Envelope> {
  const to = STATUS_FOR[action];
  if (!to) return fail('BAD_INPUT', 'disable | enable | undo | confirm');
  const l = readLessons().find((x) => x.id === id);
  if (!l) return fail('NOT_FOUND', `没有教训 ${id}`);
  if (to === 'active') {
    const g = gate(l, await gateRuns());
    if (!g.ok) return fail('BAD_INPUT', `回放：教训 ${id} 会压掉已确认的真问题 ${g.hiddenTrue.map((x) => `${x.run}#${x.n}`).join('、')}，先收窄范围`);
  }
  const now = new Date().toISOString();
  const next = updateLessons((items) => {
    const x = items.find((y) => y.id === id)!;
    x.status = to;
    x.updatedAt = now;
    x.reason = `${action} by ${by} ${now}`;
    return x;
  });
  return ok('OK', `教训 ${id}：${next.status}`, next, lessonText(next));
}

/** Edit (scope / when / do / counter / preview); checked and gated before it is kept active. */
export async function editLesson(id: string, b: any, by: string): Promise<Envelope> {
  const cur = readLessons().find((x) => x.id === id);
  if (!cur) return fail('NOT_FOUND', `没有教训 ${id}`);
  const next: Lesson = { ...cur, ...(b.scope ? { scope: b.scope } : {}), ...(Array.isArray(b.when) ? { when: b.when.map(String) } : {}), ...(b.do ? { do: b.do } : {}), ...(typeof b.counter === 'string' ? { counter: b.counter } : {}), ...(typeof b.preview === 'string' ? { preview: b.preview } : {}), updatedAt: new Date().toISOString(), reason: `edited by ${by}` };
  const bad = checkLesson(next);
  if (bad) return fail('BAD_INPUT', bad);
  if (next.status === 'active') {
    const g = gate(next, await gateRuns());
    if (!g.ok) {
      next.status = 'candidate';
      next.reason = `改后回放会压掉真问题 ${g.hiddenTrue.map((x) => `${x.run}#${x.n}`).join('、')}：降为候选`;
    }
  }
  updateLessons((items) => void (items[items.findIndex((x) => x.id === id)] = next));
  return ok('OK', `已修改教训 ${id}（${next.status}）`, next, lessonText(next));
}

/** The replay report over the data set (§8.8): with and without the active lessons. */
export async function replayReport(): Promise<Envelope> {
  const runs = await gateRuns();
  const r = replay(runs, readLessons().filter((l) => l.status === 'active'));
  return ok('OK', `回放 ${runs.length} 次运行、${r.rows.length} 个发现`, { runs: runs.length, ...r }, reportText(r));
}

/** D14: atoms the service extracted since the last pull → candidate lessons (L3 only, scope = the surface), each
 *  waiting for a person's one-click confirm. */
export async function pullCandidates(surface = 'android-app'): Promise<Envelope> {
  const mem = memoryClient();
  const h = await mem.health();
  if (!h.ok) return fail('PLATFORM_DOWN', `记忆服务不可用：${h.detail}`, 'docker compose up -d memory-core');
  const have = readLessons();
  const since = have.filter((l) => l.source === 'memory-service').map((l) => l.createdAt).sort().pop();
  const atoms = (await mem.queryAtoms({ agent: 'explore', user: memoryUser(surface) }, { since, limit: 50 })) ?? [];
  const now = new Date().toISOString();
  const added: Lesson[] = [];
  for (const a of atoms) {
    const id = `L-mem-${a.id.replace(/[^\w-]/g, '').slice(0, 24)}`;
    if (!a.content.trim() || have.some((l) => l.id === id)) continue;
    added.push({ id, scope: { surface }, when: ['always'], class: 'test-method', do: { L3: a.content.slice(0, 300) }, counter: '崩溃、报错文字、白屏仍要报', preview: `记忆服务抽取：${a.content.slice(0, 80)}`, evidence: [], status: 'candidate', source: 'memory-service', createdAt: now, reason: `atom ${a.id}（${a.type}）：等人确认` });
  }
  if (added.length) updateLessons((items) => void items.push(...added));
  return ok('OK', `拉取 ${atoms.length} 条经验，新增候选 ${added.length} 条`, added, added.map((l) => lessonText(l)).join('\n') || '没有新的候选');
}

export async function memoryStatus(): Promise<Envelope> {
  const h = await memoryClient().health();
  const ls = readLessons();
  const triage = readTriage();
  const d = { service: h, lessons: { total: ls.length, active: ls.filter((l) => l.status === 'active').length, candidate: ls.filter((l) => l.status === 'candidate').length }, marks: triage.length };
  return ok('OK', `记忆服务：${h.ok ? '正常' : '不可用'}（${h.detail}）；教训 ${d.lessons.active} 条生效、${d.lessons.candidate} 条候选`, d);
}
