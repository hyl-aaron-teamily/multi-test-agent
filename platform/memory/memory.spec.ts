// W5-R6: lessons (matching, `when`, L2 judging, conflicts), the replay gate, learning from a mark (rule path),
// and the memory-service client (field types, degrading) on a fake service.
import { describe, expect, it } from 'vitest';
import { atomOf, MemoryClient, parseSkillMd, skillMd, type Transport } from '../../core/memory/client';
import { tmpDir } from '../../core/testing/tmp-dir';
import type { AgentResult, Finding } from '../../engine/agent/run';
import { checkLesson, conflicts, type Lesson, lessonBlock, lessonsForStep, readLessons, suppresses, updateLessons, whenHolds } from './lessons';
import { learn, lessonFromAnswer, ruleLesson } from './learn';
import { actionType, contextAt, gate, replay, type ReplayRun, runOf } from './replay';

const at = '2026-11-19T00:00:00.000Z';
const L = (p: Partial<Lesson>): Lesson => ({ id: 'L-x', scope: { surface: 'android-app' }, when: ['always'], class: 'test-method', do: { L3: 'x' }, counter: '崩溃仍要报', preview: 'p', evidence: [], status: 'active', source: 'human', createdAt: at, ...p });

const echo = L({ id: 'L-input-echo', when: ['after:type'], do: { L1: 'type.verifyCommit', L2: 'suppress:input-echo', L3: '输入没上屏时先读回，再继续' } });

describe('W3-5 lessons: when, injection, judging', () => {
  it('when conditions are computed by the executor only', () => {
    const c = { surface: 'android-app', page: 'chat', lastAction: 'type', readback: ['input not committed'] };
    expect(whenHolds('always', c)).toBe(true);
    expect(whenHolds('after:type', c)).toBe(true);
    expect(whenHolds('after:tap', c)).toBe(false);
    expect(whenHolds('page:chat', c)).toBe(true);
    expect(whenHolds("readback:'input not committed'", c)).toBe(true);
    expect(whenHolds('finding:reported', { ...c, findingType: 'reported' })).toBe(true);
  });
  it('a lesson goes into the prompt only at its moment (after a type), at most 5', () => {
    expect(lessonsForStep([echo], { surface: 'android-app', lastAction: 'tap' })).toEqual([]);
    expect(lessonsForStep([echo], { surface: 'android-app', lastAction: 'type' }).map((l) => l.id)).toEqual(['L-input-echo']);
    expect(lessonsForStep([echo], { surface: 'desktop-web', lastAction: 'type' })).toEqual([]);
    expect(lessonsForStep([{ ...echo, status: 'candidate' }], { surface: 'android-app', lastAction: 'type' })).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => L({ id: `L-a${i}` }));
    expect(lessonsForStep(many, { surface: 'android-app' })).toHaveLength(5);
    expect(lessonBlock([echo], ['相关经验'])).toMatch(/\[L-input-echo\] 输入没上屏时先读回，再继续（仍要报：崩溃仍要报）[\s\S]*（参考）相关经验/);
    expect(lessonBlock([])).toBe('');
  });
  it('L2: suppresses the family it names, never human findings, only in scope and when', () => {
    const f = { source: 'reported', type: 'reported', text: '搜索框里不显示输入的文字', page: 'home', step: 4 };
    expect(suppresses(echo, f, { surface: 'android-app', lastAction: 'type' })).toBe(true);
    expect(suppresses(echo, f, { surface: 'android-app', lastAction: 'tap' })).toBe(false);
    expect(suppresses(echo, { ...f, source: 'human' }, { surface: 'android-app', lastAction: 'type' })).toBe(false);
    expect(suppresses(echo, { ...f, text: '点开后白屏' }, { surface: 'android-app', lastAction: 'type' })).toBe(false);
    const k = L({ id: 'L-k', scope: { surface: 'android-app', page: 'home' }, do: { L2: 'suppress:known:K004' } });
    expect(suppresses(k, { ...f, knownId: 'K004' }, { surface: 'android-app' })).toBe(true);
    expect(suppresses(k, { ...f, knownId: 'K004', page: 'chat' }, { surface: 'android-app' })).toBe(false);
  });
  it('checks lessons and finds conflicts', () => {
    expect(checkLesson(echo)).toBeUndefined();
    expect(checkLesson({ ...echo, when: ['model-thinks-so'] })).toMatch(/when/);
    expect(checkLesson({ ...echo, do: { L2: 'suppress:everything' } })).toMatch(/L2/);
    expect(checkLesson({ ...echo, do: { L2: 'suppress:text:(' } })).toMatch(/正则/);
    expect(checkLesson({ ...echo, counter: '' })).toMatch(/counter/);
    expect(conflicts(echo, { ...echo, id: 'L-y', class: 'environment' })).toBe(true);
    expect(conflicts(echo, { ...echo, id: 'L-y' })).toBe(false);
  });
  it('device lessons go to the local file', () => {
    const dir = tmpDir('mta-lessons-');
    const o = { shared: `${dir}/lessons.jsonl`, local: `${dir}/lessons.local.jsonl` };
    updateLessons((items) => void items.push(echo, { ...echo, id: 'L-dev', device: 'emulator-5556' }), o);
    expect(readLessons({ shared: o.shared, local: `${dir}/none` }).map((l) => l.id)).toEqual(['L-input-echo']);
    expect(readLessons(o).find((l) => l.id === 'L-dev')?.device).toBe('emulator-5556');
  });
});

// A run of the data set: a type that never landed, then a "search box empty" report (labelled not-issue), and a
// real problem (labelled issue) on the same page.
const run1: ReplayRun = {
  run: 't1',
  surface: 'android-app',
  steps: [
    { step: 3, action: 'type #1 "aaron"', readback: ['input not committed'], page: 'home' },
    { step: 4, action: 'report_issue', page: 'home' },
    { step: 5, action: 'tap #2', page: 'home' },
  ],
  findings: [
    { n: 1, source: 'reported', type: 'reported', text: '搜索框里不显示输入的文字', page: 'home', step: 4, base: true, label: 'not-issue' },
    { n: 2, source: 'reported', type: 'reported', text: '会话列表出现 [自定义消息] 占位', page: 'home', step: 6, base: true, label: 'issue' },
  ],
};

describe('W3-5 §8.8 replay and the gate', () => {
  it('reads the executor context back from the steps', () => {
    expect(actionType('type #1 "aaron"')).toBe('type');
    expect(contextAt(run1, 4)).toMatchObject({ lastAction: 'report_issue', readback: ['input not committed'] });
    expect(contextAt(run1, 3)).toMatchObject({ lastAction: 'type' });
  });
  it('a narrow lesson removes the false report and keeps the real one', () => {
    const l = { ...echo, when: ["readback:input not committed"] };
    const r = replay([run1], [l]);
    expect(r.before).toEqual({ counted: 2, falsePositives: 1, truePositives: 1 });
    expect(r.after).toEqual({ counted: 1, falsePositives: 0, truePositives: 1 });
    expect(r.removedFalse.map((x) => x.n)).toEqual([1]);
    expect(gate(l, [run1]).ok).toBe(true);
  });
  it('a lesson that hides a confirmed problem fails the gate', () => {
    const wide = L({ id: 'L-wide', do: { L2: 'suppress:type:reported' } });
    const g = gate(wide, [run1]);
    expect(g.ok).toBe(false);
    expect(g.hiddenTrue.map((x) => x.n)).toEqual([2]);
  });
  it('builds runs from exploration results and triage marks', () => {
    const r = runOf('t9', { surface: 'android-app', steps: [{ step: 1, action: 'tap #1', page: 'chat' }], findings: [{ n: 1, source: 'detector', detector: 'placeholder', text: '[自定义消息]', description: 'x', step: 1, counted: true }, { n: 2, source: 'reported', description: 'y', step: 1, counted: false, lesson: 'L-a' }] }, [{ run: 't9', n: 1, verdict: 'issue' }]);
    expect(r.findings).toEqual([expect.objectContaining({ n: 1, type: 'placeholder', text: '[自定义消息]', base: true, label: 'issue' }), expect.objectContaining({ n: 2, base: true })]);
  });
});

const finding = (p: Partial<Finding>): Finding => ({ n: 1, source: 'reported', kind: 'visual-anomaly', description: '搜索框里不显示输入的文字', step: 4, screen: 's', incident: '', counted: true, path: [], page: 'home', ...p }) as Finding;
const result = (fs: Finding[]): Pick<AgentResult, 'surface' | 'steps' | 'findings' | 'runDir'> => ({ surface: 'android-app', runDir: '', findings: fs, steps: [{ step: 3, screen: 's', action: 'type #1 "aaron"', result: 'input not committed', readback: ['input not committed'], page: 'home' }, { step: 4, screen: 's', action: 'report_issue', result: 'ok', page: 'home' }] });

describe('W3-5 §8.7 ③ one sentence → one lesson', () => {
  it('by rule: the input-echo family, or the finding\'s known issue on its page', () => {
    expect(ruleLesson({ run: 't', result: result([]), finding: finding({}), note: '未输入', verdict: 'not-issue' })).toMatchObject({ id: 'L-input-echo', do: { L2: 'suppress:input-echo', L1: 'type.verifyCommit' }, class: 'test-method' });
    const k = ruleLesson({ run: 't', result: result([]), finding: finding({ description: '卡片封面整块黑', known: { id: 'K007', count: 1, isNew: true } }), note: '测试账号没有封面', verdict: 'env' });
    expect(k).toMatchObject({ id: 'L-k007', scope: { surface: 'android-app', page: 'home' }, do: { L2: 'suppress:known:K007' }, class: 'environment' });
    expect(checkLesson(k)).toBeUndefined();
  });
  it('the model\'s answer is checked; unusable → undefined', () => {
    const i = { run: 't', result: result([]), finding: finding({}), note: '未输入', verdict: 'not-issue' as const };
    expect(lessonFromAnswer({ id: 'L-search-echo', when: ['after:type'], do: { L2: 'suppress:input-echo', L3: '先读回' }, counter: '读回有文字仍报', preview: 'p' }, i)).toMatchObject({ id: 'L-search-echo', scope: { surface: 'android-app' }, status: 'active' });
    expect(lessonFromAnswer({ id: 'bad', when: ['x'], do: {} }, i)).toBeUndefined();
  });
  it('learn: gated against the data set — goes live, or waits as a candidate when it would hide a real problem', async () => {
    const f1 = finding({});
    const r = await learn({ run: 'tA', result: result([f1]), finding: f1, note: '未输入', verdict: 'not-issue' }, { useModel: false, runs: [] });
    expect(r.how).toBe('rule');
    expect(r.lesson.status).toBe('active');
    expect(r.removedFalse).toBe(1);
    expect(r.synced).toBe(false); // MEMORY_OFF in tests
    expect(readLessons().map((l) => l.id)).toContain('L-input-echo');
    // A second mark of the same kind adds evidence, not a second lesson.
    await learn({ run: 'tB', result: result([f1]), finding: f1, note: '又没输入', verdict: 'not-issue' }, { useModel: false, runs: [] });
    expect(readLessons().filter((l) => l.id === 'L-input-echo')).toHaveLength(1);
    expect(readLessons().find((l) => l.id === 'L-input-echo')!.evidence).toHaveLength(2);
    // A known-issue lesson whose known issue a person confirmed elsewhere → candidate.
    const f2 = finding({ n: 2, description: '会话列表出现 [自定义消息] 占位', known: { id: 'K001', count: 2, isNew: false } });
    const confirmed: ReplayRun = { run: 'tC', surface: 'android-app', steps: [], findings: [{ n: 1, source: 'reported', type: 'reported', text: '会话列表出现 [自定义消息] 占位', page: 'home', knownId: 'K001', step: 1, base: true, label: 'issue' }] };
    const r2 = await learn({ run: 'tD', result: result([f2]), finding: f2, note: '不算', verdict: 'not-issue' }, { useModel: false, runs: [confirmed] });
    expect(r2.lesson.status).toBe('candidate');
    expect(r2.lesson.reason).toMatch(/会压掉已确认的真问题 tC#1/);
  });
});

describe('W3-5 §8.9 memory-service client (fake service)', () => {
  const fake = (h: (path: string, body: any) => { status?: number; json: any } | Promise<never>): Transport => async (path, body) => {
    const r = await h(path, body);
    return { status: r.status ?? 200, json: r.json };
  };
  it('isolation fields, envelope, version types unified', async () => {
    const seen: any[] = [];
    const c = new MemoryClient({ base: 'http://x', transport: fake((path, body) => (seen.push({ path, body }), path === '/v3/atomic/search' ? { json: { code: 0, data: { items: [{ id: 'a1', type: 'instruction', content: '先读回', score: 0.9, version: 3 }] } } } : path === '/v3/atomic/update' ? { json: { code: 0, data: { version: '4' } } } : { json: { code: 0, data: { accepted_ids: ['m1'] } } })) });
    process.env.MEMORY_OFF = '0';
    try {
      expect(await c.searchAtoms({ agent: 'explore', user: 'teamily-android' }, 'q')).toEqual([{ id: 'a1', type: 'instruction', content: '先读回', score: 0.9, version: 3 }]);
      expect((await c.updateAtom({ agent: 'explore', user: 'teamily-android' }, 'a1', 'new'))?.version).toBe(4);
      expect(await c.addConversation({ agent: 'explore', user: 'teamily-android', session: 's1' }, [{ role: 'user', content: 'x' }])).toBe(true);
      expect(seen[0].body).toMatchObject({ team_id: 'multi-test-agent', agent_id: 'explore', user_id: 'teamily-android', query: 'q', limit: 3 });
      expect(seen[2].body).toMatchObject({ session_id: 's1', messages: [{ role: 'user', content: 'x' }] });
    } finally {
      process.env.MEMORY_OFF = '1';
    }
  });
  it('degrades: errors, business codes, timeouts and MEMORY_OFF give undefined / false, never throw', async () => {
    process.env.MEMORY_OFF = '0';
    try {
      const down = new MemoryClient({ transport: async () => Promise.reject(new Error('ECONNREFUSED')) });
      expect(await down.searchAtoms({ agent: 'explore', user: 'u' }, 'q')).toBeUndefined();
      expect(await down.addConversation({ agent: 'explore', user: 'u', session: 's' }, [{ role: 'user', content: 'x' }])).toBe(false);
      expect((await down.health()).ok).toBe(false);
      const refused = new MemoryClient({ transport: fake(() => ({ json: { code: 40001, message: 'bad' } })) });
      expect(await refused.searchAtoms({ agent: 'explore', user: 'u' }, 'q')).toBeUndefined();
      expect(refused.log[0]).toMatchObject({ ok: false, error: expect.stringMatching(/bad/) });
    } finally {
      process.env.MEMORY_OFF = '1';
    }
    const off = new MemoryClient({ transport: fake(() => ({ json: { code: 0, data: { items: [] } } })) });
    expect(await off.searchAtoms({ agent: 'explore', user: 'u' }, 'q')).toBeUndefined();
  });
  it('repair cases: SKILL.md round trip; update reads the version first (optimistic lock)', async () => {
    expect(parseSkillMd(skillMd({ name: 'fix-x', description: 'd', content: 'body\nline' }))).toEqual({ description: 'd', body: 'body\nline' });
    const store: Record<string, { id: string; version: number; content: string }> = {};
    const c = new MemoryClient({
      transport: fake((path, b) => {
        if (path === '/v3/skill/create') return (store[b.name] = { id: 'sk1', version: 1, content: b.content }), { json: { code: 0, data: { skill_id: 'sk1', name: b.name, version: 1 } } };
        if (path === '/v3/skill/get-by-name') return store[b.skill_name] ? { json: { code: 0, data: { skill_id: 'sk1', name: b.skill_name, version: store[b.skill_name].version, content: store[b.skill_name].content } } } : { status: 404, json: { code: 40401 } };
        if (path === '/v3/skill/update') {
          const s = Object.values(store).find((x) => x.id === b.skill_id)!;
          if (b.expected_version !== s.version) return { status: 409, json: { code: 40901 } };
          s.version++;
          s.content = b.content;
          return { json: { code: 0, data: { version: s.version } } };
        }
        return { status: 404, json: { code: 404 } };
      }),
    });
    process.env.MEMORY_OFF = '0';
    try {
      const iso = { agent: 'plan-run' as const, user: 'teamily-android' };
      expect(await c.createSkill(iso, { name: 'fake-repair', description: '假案例', content: 'step 3: wait 2s' })).toMatchObject({ id: 'sk1', version: 1 });
      expect(await c.updateSkill(iso, { name: 'fake-repair', description: '假案例', content: 'step 3: wait 3s' })).toMatchObject({ version: 2 });
      expect(await c.getSkill(iso, 'fake-repair')).toMatchObject({ name: 'fake-repair', description: '假案例', content: 'step 3: wait 3s', version: 2 });
      expect(await c.getSkill(iso, 'none')).toBeUndefined();
    } finally {
      process.env.MEMORY_OFF = '1';
    }
  });
  it('atomOf normalises', () => {
    expect(atomOf({ id: 1, type: 't', content: 'c', version: '' })).toEqual({ id: '1', type: 't', content: 'c' });
  });
});
