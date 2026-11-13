// /api/v1/explore/… for the exploration judgment (W3-4 §8.5): the expectation checklist (list, edit, disable,
// first drafts from the Issue drafts), focus modules, known issues, and people's marks on a finished run —
// 「这是问题」 on a step (a new finding with that step's screenshot), 「不是问题」 / 「环境问题」 on a finding. Marks
// are written to platform/explore/triage.json and onto the known issue; rules from them are W3-5.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentResult, Finding } from '../engine/agent/run';
import { findingKey, judgeFinding } from '../engine/explore/judge';
import { checkExpectation, type Expectation, extractFromDrafts, readExpectations, writeExpectations } from '../engine/explore/expectations';
import { addTriage, readKnown, recordKnown, TRIAGE_TEXT, type TriageVerdict, updateKnown } from '../engine/explore/known';
import { issueTexts, rankModules } from '../engine/explore/modules';
import { TEAMILY_PAGES } from '../skills/teamily/page-rules';
import { apiError, type Code, outcome } from './lifecycle/status';
import { getTask, readResult, writeResult } from './lifecycle/task';
import type { Envelope } from './api-v1';

const ok = (code: Code, summary: string, data?: unknown, text?: string): Envelope => ({ ...outcome(code), summary, data, text });
const fail = (code: Code, message: string, hint?: string): Envelope => ({ ...outcome(code), summary: message, error: apiError(code, message, hint) });

const PAGES = TEAMILY_PAGES.map((p) => ({ id: p.id, name: p.name }));

// ---------------------------------------------------------------- checklist

export function listExpectations(): Envelope {
  const items = readExpectations();
  const on = items.filter((e) => e.enabled).length;
  return ok('OK', `${items.length} 条预期（启用 ${on}）`, { items, pages: PAGES }, items.map((e) => `${e.enabled ? '✓' : '·'} [${e.id}] (${e.page || '-'}) ${e.trigger} → ${e.expect}  ${e.source}${e.note ? `  # ${e.note}` : ''}`).join('\n'));
}

/** Add or change one entry (people on the explore page). */
export function putExpectation(id: string, b: any): Envelope {
  const items = readExpectations();
  const i = items.findIndex((e) => e.id === id);
  const prev = i >= 0 ? items[i] : undefined;
  const e: Expectation = {
    id,
    page: typeof b.page === 'string' ? b.page.trim() : (prev?.page ?? ''),
    trigger: typeof b.trigger === 'string' ? b.trigger.trim() : (prev?.trigger ?? ''),
    expect: typeof b.expect === 'string' ? b.expect.trim() : (prev?.expect ?? ''),
    source: prev?.source ?? 'manual',
    enabled: typeof b.enabled === 'boolean' ? b.enabled : (prev?.enabled ?? true),
    ...(typeof b.note === 'string' ? (b.note.trim() ? { note: b.note.trim() } : {}) : prev?.note ? { note: prev.note } : {}),
  };
  const bad = checkExpectation(e);
  if (bad) return fail('BAD_INPUT', bad);
  if (i >= 0) items[i] = e;
  else items.push(e);
  writeExpectations(items);
  return ok('OK', `${prev ? '已修改' : '已添加'}预期 ${id}`, e);
}

export function deleteExpectation(id: string): Envelope {
  const items = readExpectations();
  if (!items.some((e) => e.id === id)) return fail('NOT_FOUND', `没有预期 ${id}`);
  writeExpectations(items.filter((e) => e.id !== id));
  return ok('OK', `已删除预期 ${id}`);
}

/** First drafts from the Issue drafts' understanding.expected (D9); entries already there stay as they are. */
export function extractExpectations(): Envelope {
  const { items, added } = extractFromDrafts();
  writeExpectations(items);
  return ok('OK', `从草稿提取 ${added.length} 条新预期（共 ${items.length} 条）`, { added, total: items.length }, added.map((e) => `+ [${e.id}] (${e.page || '-'}) ${e.trigger} → ${e.expect}${e.enabled ? '' : '  （停用）'}`).join('\n') || '没有新的预期');
}

export function listModules(): Envelope {
  const m = rankModules(issueTexts());
  return ok('OK', `${m.length} 个模块（按 Issue 数排序）`, m, m.map((x) => `${x.id.padEnd(14)} ${x.name}  ${x.issues}`).join('\n'));
}

export function listKnown(): Envelope {
  const items = readKnown().sort((a, b) => b.last.localeCompare(a.last));
  return ok('OK', `${items.length} 个已知问题`, items, items.map((k) => `${k.id} (${k.page}, ${k.type}) ×${k.count}${k.triage ? ` [${TRIAGE_TEXT[k.triage.verdict]}]` : ''} ${k.sample.slice(0, 80)}`).join('\n'));
}

// ---------------------------------------------------------------- marks on a run

type Stored = { agent?: AgentResult } & Record<string, unknown>;

function loadRun(taskId: string): { stored: Stored; r: AgentResult } | Envelope {
  const t = getTask(taskId);
  if (!t) return fail('NOT_FOUND', `没有任务 ${taskId}`);
  if (t.kind !== 'explore') return fail('BAD_INPUT', `任务 ${taskId} 不是探索任务`);
  const stored = readResult<Stored>(taskId);
  if (!stored?.agent) return fail('BAD_INPUT', `任务 ${taskId} 还没有结果（结束后才能标注）`);
  return { stored, r: stored.agent };
}

function saveRun(taskId: string, stored: Stored, r: AgentResult): void {
  stored.agent = r;
  writeResult(taskId, stored);
  if (existsSync(r.runDir)) {
    // The run's own result.json follows (report.md stays as the run wrote it; the result page shows the marks).
    writeFileSync(join(r.runDir, 'result.json'), JSON.stringify(r, null, 2));
  }
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 「这是问题」 on a step: a finding from the person's sentence, with that step's screenshot. */
export function markStep(taskId: string, b: any): Envelope {
  const got = loadRun(taskId);
  if ('status' in got) return got;
  const { stored, r } = got;
  const step = Number(b.step);
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (!note || note.length > 500) return fail('BAD_INPUT', '写一句话说明问题（1–500 个字）');
  const s = r.steps.find((x) => x.step === step);
  if (!s) return fail('NOT_FOUND', `任务 ${taskId} 没有第 ${b.step} 步`);
  const n = r.findings.length + 1;
  const dir = join(r.runDir, 'incidents', `${n}-human`);
  mkdirSync(dir, { recursive: true });
  const shot = s.thumb && existsSync(join(r.runDir, s.thumb)) ? 'step.png' : undefined;
  if (shot) copyFileSync(join(r.runDir, s.thumb!), join(dir, shot));
  const at = new Date().toISOString();
  writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>人工标注 #${n}</title><h1>人工标注 #${n}：第 ${step} 步</h1><p>${escHtml(note)}</p><p>动作：${escHtml(s.action)}</p>${shot ? `<img src="${shot}" style="max-width:480px">` : '<p>（这一步没有截图）</p>'}<p>${at}</p>`);
  const f: Finding = { n, source: 'human', kind: 'visual-anomaly', description: note, step, screen: s.screen, incident: dir, counted: true, path: [], ...(s.page ? { page: s.page } : {}), triage: { verdict: 'issue', note, at } };
  updateKnown((items) => {
    judgeFinding(f, r.steps, items, taskId, at);
    const k = items.find((x) => x.id === f.known?.id);
    if (k) k.triage = { verdict: 'issue', note, at };
  });
  r.findings.push(f);
  saveRun(taskId, stored, r);
  addTriage({ run: taskId, n, step, verdict: 'issue', note, description: note, page: f.page, known: f.known?.id, at });
  return ok('OK', `已记为发现 #${n}${f.known && !f.known.isNew ? `（已知问题 ${f.known.id}，累计 ${f.known.count} 次）` : ''}`, f);
}

/** 「是问题 / 不是问题 / 环境问题」 on a finding the model or a rule reported. */
export function triageFinding(taskId: string, b: any): Envelope {
  const got = loadRun(taskId);
  if ('status' in got) return got;
  const { stored, r } = got;
  const verdict = String(b.verdict ?? '') as TriageVerdict;
  if (!(verdict in TRIAGE_TEXT)) return fail('BAD_INPUT', 'verdict：issue | not-issue | env');
  const f = r.findings.find((x) => x.n === Number(b.n));
  if (!f) return fail('NOT_FOUND', `任务 ${taskId} 没有发现 #${b.n}`);
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : undefined;
  const at = new Date().toISOString();
  f.triage = { verdict, ...(note ? { note } : {}), at };
  // The known issue carries the triage, so the next run's same finding is judged by it (§8.5 ④).
  const knownId = updateKnown((items) => {
    const key = findingKey(f);
    const k = f.known ? items.find((x) => x.id === f.known!.id) : undefined;
    const issue = k ?? recordKnown(items, { ...key, description: f.description }, { run: taskId, n: f.n, at }).issue;
    issue.triage = { verdict, ...(note ? { note } : {}), at };
    f.known ??= { id: issue.id, count: issue.count, isNew: issue.count === 1 };
    return issue.id;
  });
  saveRun(taskId, stored, r);
  addTriage({ run: taskId, n: f.n, step: f.step, verdict, ...(note ? { note } : {}), description: f.description, page: f.page, known: knownId, at });
  return ok('OK', `发现 #${f.n} 标注为「${TRIAGE_TEXT[verdict]}」（已知问题 ${knownId}）`, f);
}
