// W3-6 §8.4 ③④⑤: numbered Issue + quotes by line, two-stage design, ops-only fix (fake model, real validator).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authorTwoStage, blockNames, catalogFor, expandQuotes, linesText, numberedIssue, unknownBlocks } from './design';
import { asRecord, compileRecord, contextOf, patchRecord } from './record';

const draft = () => JSON.parse(readFileSync('fixtures/w3m6/2730.draft.json', 'utf8'));
const quotes = (draft().envelope.quotes as { id: string; text: string }[]);
const raw = quotes.map((q) => q.text).join('\n');
// each quote's line range in `raw`
let at = 1;
const ranges = quotes.map((q) => {
  const n = q.text.split('\n').length;
  const r = n > 1 ? `L${at}-L${at + n - 1}` : `L${at}`;
  at += n;
  return { id: q.id, lines: r };
});
const textCheck = (expect: string, contains: string) => ({ kind: 'text', expect, match: { contains }, scope: 'screen' });

/** The 2730 delivery made valid by the two human patches of record.spec (expect.check, then baseline). */
function validEnvelope() {
  const r0 = asRecord(draft());
  const r = { ...r0, ...compileRecord(r0, r0.envelope!, contextOf(r0, 7, raw)) };
  const r7 = patchRecord(r, r.partial!.flatMap((p) => p.errors.map((e) => ({ op: 'replace' as const, path: e.path, value: textCheck('设置列表滚到了偏好与安全分组', '偏好与安全') }))), { source: 'human', reason: 'x', raw });
  const r8 = patchRecord(r7, r7.partial!.flatMap((p) => p.errors.map((e) => ({ op: 'replace' as const, path: e.path, value: textCheck('设置页可见', '设置') }))), { source: 'human', reason: 'y', raw });
  return { record: r0, broken: r0.envelope!, valid: r8.envelope!, r7 };
}

describe('W3-6 leaner design', () => {
  it('numbers lines as in the file; comments dropped, images as [图n]; ranges expand verbatim', () => {
    const md = 'Title\n\n<!-- hidden\nstill hidden -->\n步骤：长按 ![a](x.png) 消息\n预期 <img src="y"> 弹出';
    expect(numberedIssue(md)).toBe('L1 Title\nL5 步骤：长按 [图1] 消息\nL6 预期 [图2] 弹出');
    expect(linesText(md, 'L5-L6')).toBe('步骤：长按 ![a](x.png) 消息\n预期 <img src="y"> 弹出');
    expect(linesText(md, 'L9')).toBeUndefined();
    const e = expandQuotes([{ id: 'q1', lines: 'L1' }, { id: 'q2', text: '自带' }, { id: 'q3', lines: 'L0' }, { id: 'q4' }], md);
    expect(e.quotes).toEqual([{ id: 'q1', text: 'Title', lines: 'L1' }, { id: 'q2', text: '自带' }]);
    expect(e.errors).toHaveLength(2);
  });

  it('stage 1 sees names only; stage 2 sees the chosen Nodes only', () => {
    expect(blockNames()).toContain('teamily.openConversation');
    expect(blockNames()).not.toContain('teamily.login');
    const c = catalogFor(['teamily.openConversation']);
    expect(c).toContain('`teamily.openConversation`');
    expect(c).not.toContain('`teamily.sendMessage`');
    expect(unknownBlocks(['teamily.openConversation', 'teamily.flyToMoon', 'text'])).toEqual(['teamily.flyToMoon']);
  });

  const stage1 = (env: any, extra: Record<string, unknown> = {}) => ({ quotes: ranges, understanding: env.understanding, feasibility: { status: 'plannable', missing: [] }, blocks: ['teamily.openConversation'], ...extra });
  const fake = (answers: unknown[]) => {
    const seen: { system: string; user: string }[] = [];
    return { seen, ask: async (system: string, user: string) => (seen.push({ system, user }), answers[seen.length - 1]) };
  };

  it('a block not in the catalog → needs-block after one call (rule, not the model)', async () => {
    const { record, valid } = validEnvelope();
    const f = fake([stage1(valid, { blocks: ['teamily.flyToMoon'] })]);
    const a = await authorTwoStage({ ...contextOf(record, 1, raw) }, { ask: f.ask, userPrompt: () => `# Issue 2730（原文，逐字）\n${raw}\n\n# 条件`, logs: undefined });
    expect(a.calls).toBe(1);
    expect(a.envelope!.feasibility.status).toBe('needs-block');
    expect(a.envelope!.feasibility.missing.at(-1)!.need).toContain('teamily.flyToMoon');
    expect(f.seen[0].user).toContain('L1 ');
    expect(f.seen[0].system).not.toContain('## 5.');
  });

  it('plannable: stage 2 gets the stage-1 result and returns only subcases; quotes are expanded from lines', async () => {
    const { record, valid } = validEnvelope();
    const f = fake([stage1(valid), { subcases: valid.subcases, risks: ['a', 'b', 'c', 'd'] }]);
    const a = await authorTwoStage(contextOf(record, 1, raw), { ask: f.ask, userPrompt: () => `# Issue 2730（原文，逐字）\n${raw}`, logs: undefined });
    expect(a.errors).toEqual([]);
    expect(a.calls).toBe(2);
    expect(a.envelope!.quotes.map((q) => q.text)).toEqual(quotes.map((q) => q.text));
    expect(a.envelope!.risks).toHaveLength(3);
    expect(f.seen[1].user).toContain('# 第一段结果（已确定）');
    expect(f.seen[1].system).toContain('`teamily.openConversation`');
    expect(f.seen[1].system).not.toContain('- `teamily.sendMessage` [phase');
    expect(a.subcases.every((s) => s.plan && !s.errors.length)).toBe(true);
  });

  it('a delivery failing validation gets one ops-only fix (failing sub-cases + paths), not a full redo', async () => {
    const { record, r7 } = validEnvelope();
    const env7 = r7.envelope!;
    const fixOps = r7.partial!.flatMap((p) => p.errors.map((e) => ({ op: 'replace', path: e.path, value: textCheck('设置页可见', '设置') })));
    const f = fake([stage1(env7), { subcases: env7.subcases }, { ops: fixOps }]);
    const a = await authorTwoStage(contextOf(record, 1, raw), { ask: f.ask, userPrompt: () => `# Issue 2730（原文，逐字）\n${raw}`, logs: undefined });
    expect(a.calls).toBe(3);
    expect(f.seen[2].user).toContain('# 校验错误');
    expect(f.seen[2].user).toContain('R5 baseline');
    expect(a.errors).toEqual([]);
  });
});
