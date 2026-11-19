// One sentence → one lesson (W3-5 §8.7 ③, D12): a person marks a finding 「不是问题 / 环境问题」 with a sentence;
// one small model call distils it into a structured lesson (context: the steps around it, the finding, at most
// three related experiences from the memory service); the replay gate checks it; it goes live at once unless it
// would hide a confirmed problem (then it waits as a candidate, with the reason). A person can edit or undo it.
// Without a model the lesson is built by rule (the finding's known issue, or the D10 family).
import { modelCall } from '../../core/context/assemble';
import { memoryClient, memoryUser } from '../../core/memory/client';
import { modelConfigured } from '../../core/model/llm';
import type { AgentResult, Finding } from '../../engine/agent/run';
import { checkLesson, conflicts, INPUT_ECHO, L1_GUARDS, type Lesson, type LessonClass, readLessons, updateLessons } from './lessons';
import { gate, readDataset, type ReplayRun, runOf } from './replay';

const DISTILL_SYSTEM = `You turn one tester's sentence about a finding of an automated app exploration into ONE structured lesson, so the
explorer does not make the same mistake again. Answer with ONE JSON object:
{"id":"L-<short-kebab-name>","scope":{"surface":"android-app","page":"<page id or omit>","action":"<action type or omit>"},
 "when":["<condition>",...],"class":"test-method|environment|app-behaviour|not-a-bug",
 "do":{"L2":"<judging rule or omit>","L3":"<one instruction for the explorer, Chinese>","L1":"<executor guard name or omit>"},
 "counter":"<what must STILL be reported, Chinese>","preview":"<one Chinese sentence for people>"}
Conditions (only these; they are computed by the executor, never by a model):
  always | after:<action type, e.g. type, tap, swipe> | page:<page id> | readback:<text in the last read-back> | finding:<finding type>
Judging rules (L2, make the finding not count):
  suppress:input-echo   typed text "not showing" reports (the input-method family)
  suppress:type:<type>  every finding of that type in the scope
  suppress:text:<regex> findings whose text matches (keep it narrow)
  suppress:known:<Kid>  exactly that known issue
Keep the scope as narrow as the evidence allows; never suppress crashes. "counter" names what still counts.`;

export interface LearnInput {
  run: string;
  result: Pick<AgentResult, 'surface' | 'steps' | 'findings' | 'runDir'>;
  finding: Finding;
  note: string;
  verdict: 'not-issue' | 'env';
}

export interface LearnOutcome {
  lesson: Lesson;
  /** Replay: false reports it removes / confirmed problems it would hide. */
  removedFalse: number;
  hiddenTrue: { run: string; n: number }[];
  how: 'model' | 'rule';
  /** Memory service: the related experiences used (count), whether the copy was synced. */
  related: number;
  synced: boolean;
}

/** Pure: the text the distillation sees (§8.7 ③: the steps around it, the finding, related experience). */
export function distillContext(i: LearnInput, related: string[] = []): string {
  const f = i.finding;
  const near = i.result.steps.filter((s) => Math.abs(s.step - f.step) <= 3);
  return [
    `Tester's verdict: ${i.verdict === 'env' ? 'environment problem, not the app' : 'not a problem'} — "${i.note}"`,
    `Finding #${f.n} (${f.source}${f.detector ? `/${f.detector}` : ''}${f.expectation ? `/expectation ${f.expectation.id}` : ''}) at step ${f.step} on page ${f.page ?? 'unknown'}${f.known ? `, known issue ${f.known.id}` : ''}: ${f.description}`,
    'Steps around it:',
    ...near.map((s) => `#${s.step} [${s.page ?? '-'}] ${s.action} → ${s.result}${s.readback?.length ? ` | read-back: ${s.readback.join(' / ')}` : ''}${s.thought ? ` | thought: ${s.thought.slice(0, 200)}` : ''}`),
    ...(related.length ? ['Related experience already stored:', ...related.map((r) => `- ${r}`)] : []),
  ].join('\n');
}

const findingType = (f: Finding) => (f.source === 'detector' ? (f.detector ?? 'detector') : f.source === 'expectation' ? `expectation:${f.expectation?.id ?? ''}` : f.source === 'hard' ? `hard:${f.kind}` : f.source);

/** Pure: the lesson when no model is there (or its answer is unusable). */
export function ruleLesson(i: LearnInput, at = new Date().toISOString()): Lesson {
  const f = i.finding;
  const echo = INPUT_ECHO.test(f.description);
  const cls: LessonClass = i.verdict === 'env' ? 'environment' : echo ? 'test-method' : 'not-a-bug';
  if (echo)
    return { id: 'L-input-echo', scope: { surface: i.result.surface }, when: ['always'], class: cls, do: { L1: 'type.verifyCommit', L2: 'suppress:input-echo', L3: '输入后看不到文字时，先看读回结果：读回是 input not committed 就换方式重新输入，不要把它当作 App 的问题报告' }, counter: '读回有文字、屏幕上却不显示 → 仍按显示问题报', preview: `「${i.note}」：输入框里看不到刚输入的文字、读回没上屏，不算 App 问题`, evidence: [{ run: i.run, step: f.step, n: f.n, note: i.note }], status: 'active', source: 'human', createdAt: at };
  const id = `L-${(f.known?.id ?? `${findingType(f)}-${f.n}`).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return {
    id,
    scope: { surface: i.result.surface, ...(f.page && f.page !== 'unknown' ? { page: f.page } : {}) },
    when: ['always'],
    class: cls,
    do: { ...(f.known ? { L2: `suppress:known:${f.known.id}` } : { L2: `suppress:text:${f.description.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }), L3: `${i.note}：这一类不是 App 的问题，不要再报告，也不必在这里多花步数` },
    counter: '同一页面上的崩溃、报错文字、白屏仍要报',
    preview: `「${i.note}」：${f.page ?? '这一页'}上的「${f.description.slice(0, 40)}」${i.verdict === 'env' ? '是环境问题' : '不是问题'}，以后不计入`,
    evidence: [{ run: i.run, step: f.step, n: f.n, note: i.note }],
    status: 'active',
    source: 'human',
    createdAt: at,
  };
}

/** Pure: the model's answer as a lesson (undefined = unusable). */
export function lessonFromAnswer(v: unknown, i: LearnInput, at = new Date().toISOString()): Lesson | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const a = v as Record<string, any>;
  const l: Lesson = {
    id: String(a.id ?? ''),
    scope: { ...(a.scope?.surface ? { surface: String(a.scope.surface) } : { surface: i.result.surface }), ...(a.scope?.page ? { page: String(a.scope.page) } : {}), ...(a.scope?.action ? { action: String(a.scope.action) } : {}) },
    when: Array.isArray(a.when) ? a.when.map(String) : [],
    class: ['test-method', 'environment', 'app-behaviour', 'not-a-bug'].includes(a.class) ? a.class : i.verdict === 'env' ? 'environment' : 'not-a-bug',
    do: { ...(a.do?.L1 ? { L1: String(a.do.L1) } : {}), ...(a.do?.L2 ? { L2: String(a.do.L2) } : {}), ...(a.do?.L3 ? { L3: String(a.do.L3) } : {}) },
    counter: String(a.counter ?? ''),
    preview: String(a.preview ?? i.note),
    evidence: [{ run: i.run, step: i.finding.step, n: i.finding.n, note: i.note }],
    status: 'active',
    source: 'human',
    createdAt: at,
  };
  return checkLesson(l) ? undefined : l;
}

/** The data set the gate runs on: the exported runs plus the runs of this session (with their marks). */
export async function gateRuns(extra: ReplayRun[] = []): Promise<ReplayRun[]> {
  const out = [...readDataset()];
  try {
    const { listTasks, readResult } = await import('../lifecycle/task');
    const { readTriage } = await import('../../engine/explore/known');
    const triage = readTriage();
    for (const t of listTasks()) {
      if (t.kind !== 'explore') continue;
      const r = readResult<{ agent?: AgentResult }>(t.id)?.agent;
      if (r && !out.some((x) => x.run === t.id)) out.push(runOf(t.id, r, triage));
    }
  } catch {
    /* no platform state (tests) */
  }
  for (const e of extra) {
    const i = out.findIndex((x) => x.run === e.run);
    if (i >= 0) out[i] = e;
    else out.push(e);
  }
  return out;
}

/** Distil, gate, store, sync. */
export async function learn(i: LearnInput, o: { runs?: ReplayRun[]; useModel?: boolean } = {}): Promise<LearnOutcome> {
  const mem = memoryClient();
  const iso = { agent: 'explore' as const, user: memoryUser(i.result.surface) };
  const hits = await mem.searchAtoms(iso, `${i.finding.page ?? ''} ${i.finding.description} ${i.note}`, { limit: 3, timeoutMs: 1500 });
  const related = (hits ?? []).map((h) => h.content);
  let lesson: Lesson | undefined;
  let how: LearnOutcome['how'] = 'rule';
  // AUTOTEST_LESSON_MODEL=0: always by rule (tests; no model calls).
  if (o.useModel !== false && process.env.AUTOTEST_LESSON_MODEL !== '0' && modelConfigured()) {
    const r = await modelCall({ purpose: 'lesson-distill', slots: [{ name: 'role', role: 'system', stable: true, content: DISTILL_SYSTEM }, { name: 'mark', role: 'user', content: distillContext(i, related) }], correct: true, timeoutMs: 60_000 }).catch(() => undefined);
    lesson = r?.ok ? lessonFromAnswer(r.value, i) : undefined;
    if (lesson) how = 'model';
  }
  lesson ??= ruleLesson(i);
  // The marked run, with this mark as its label, is part of the gate's data.
  const marked = runOf(i.run, i.result, []);
  const mf = marked.findings.find((x) => x.n === i.finding.n);
  if (mf) mf.label = i.verdict;
  const runs = await gateRuns([...(o.runs ?? []), marked]);
  const g = gate(lesson, runs);
  const existing = readLessons();
  const same = existing.find((l) => l.id === lesson!.id);
  if (same && same.do.L2 === lesson.do.L2 && JSON.stringify(same.scope) === JSON.stringify(lesson.scope)) {
    // The same lesson again: one more piece of evidence, not a second lesson.
    same.evidence.push(...lesson.evidence);
    lesson = { ...same, updatedAt: new Date().toISOString() };
  } else if (same) lesson.id = `${lesson.id}-${existing.filter((l) => l.id.startsWith(lesson!.id)).length + 1}`;
  if (!g.ok) {
    lesson.status = 'candidate';
    lesson.reason = `回放：会压掉已确认的真问题 ${g.hiddenTrue.map((x) => `${x.run}#${x.n}`).join('、')}，请收窄范围`;
  }
  const clash = existing.find((x) => x.id !== lesson!.id && conflicts(x, lesson!));
  if (clash && lesson.status === 'active') {
    lesson.status = 'candidate';
    lesson.reason = `和教训 ${clash.id} 冲突，交给人决定`;
  }
  if (lesson.do.L1 && !L1_GUARDS[lesson.do.L1]) lesson.reason = `${lesson.reason ? `${lesson.reason}；` : ''}L1 ${lesson.do.L1} 执行端还没有：进待修清单`;
  const final = lesson;
  updateLessons((items) => {
    const k = items.findIndex((x) => x.id === final.id);
    if (k >= 0) items[k] = final;
    else items.push(final);
  });
  const synced = await syncLesson(final);
  return { lesson: final, removedFalse: g.removedFalse.length, hiddenTrue: g.hiddenTrue.map((x) => ({ run: x.run, n: x.n })), how, related: related.length, synced };
}

/** A copy of the lesson in the memory service (searchable, shown in its panel); the mark itself as L0. */
export async function syncLesson(l: Lesson): Promise<boolean> {
  return memoryClient().addConversation({ agent: 'explore', user: memoryUser(l.scope.surface ?? 'android-app'), session: 'lessons' }, [{ role: 'user', content: `教训 ${l.id}（${l.status}）：${l.preview}。${l.do.L3 ?? ''} 仍要报：${l.counter}` }]);
}
