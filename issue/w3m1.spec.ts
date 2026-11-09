// W3-1: model-authored plans (validator rules R1–R12, authoring loop, 2063 regression shape), executor pieces
// (must, scopes, warm-up proof, revision triggers), wording (no upper bound), Issue import and GitHub.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { UiNode } from '../core/ui-tree';
import { checkMust } from '../engine/plan/expect';
import { isControl, proveChecksCanFail, WarmupError } from '../engine/plan/warmup';
import { expandAction } from '../engine/plan/template';
import { bubbleAt, scopeNodes } from '../engine/observe';
import { attemptsOf } from '../engine/stats';
import type { RunResult } from '../engine/plan/run';
import { type TestPlan, TestPlanZ } from '../platform/schema/test-plan';
import { codeOfConclusion, STATUS } from '../platform/lifecycle/status';
import { versionSentence } from '../platform/views';
import { BodyError, bodyLimit, readBody } from '../platform/server';
import { author, compile, type Envelope, EnvelopeZ, systemPrompt, userPrompt } from './author';
import { blockCatalog } from './catalog';
import { authError, issueIdOf, parseIssueUrl } from './github';
import { importId, importIssue, localizeImages, titleOf } from './import';
import { parseIssue } from './parse';
import { draftIssue, reviseIssue } from './planner';
import { materialsOf, revisionTrigger, stopsRevising } from './revise';
import { normText, validateAuthored, validatePlan } from './validate';
import { NODE_SPECS } from '../skills/teamily/node-specs';
import { ELEMENTS } from '../skills/teamily/vocab';

const RAW = readFileSync('fixtures/issues/2063.md', 'utf8');
const ISSUE = parseIssue('2063', RAW);
const ENV = (): Envelope => EnvelopeZ.parse(JSON.parse(readFileSync('issue/__fixtures__/2063-envelope.json', 'utf8')));
const CX = { issue: ISSUE, raw: RAW, surface: 'android-app' as const, env: 'prod' as const, category: 'bug-always' as const, version: 1, substitution: { from: 'ios', to: 'android-app' as const, reason: 'r' } };
const mainPlan = () => compile(ENV(), CX).find((s) => s.sub === 'main')!.plan!;
const errorsOf = (p: TestPlan) => [...validatePlan(p).errors, ...validateAuthored(p, RAW)];

describe('block catalog + prompt (§7.1)', () => {
  it('lists every element, Node (with phase), action type and the ① expect kinds; no example plan', () => {
    const c = blockCatalog();
    for (const e of ELEMENTS) expect(c).toContain(`\`${e.id}\``);
    for (const n of NODE_SPECS.filter((x) => x.name !== 'teamily.login')) expect(c).toContain(`\`${n.name}\` [phase: ${n.phase}]`);
    expect(c).toMatch(/longPress/);
    expect(c).toMatch(/expect\.check` 只能用 ①：text \/ keyboard \/ process-alive \/ visual-region/);
    const sys = systemPrompt();
    expect(sys).toContain('计划编写 SKILL');
    expect(sys).not.toMatch(/"pattern"|like-visible|templateFor|patterns.ts/);
  });
  it('the user message carries the Issue verbatim, the surface, the allow list and the version', () => {
    const u = userPrompt(CX);
    expect(u).toContain(RAW.trim().slice(0, 200));
    expect(u).toMatch(/执行端：android-app（替代执行：Issue 端 ios/);
    expect(u).toContain('"黄悦龙Aaron, 黄悦龙-AgentEval, aaron+test2"');
    expect(u).toMatch(/计划 v1/);
  });
});

describe('validator rules (§7.3) — 2063 delivery passes, each rule has a counter-example', () => {
  it('R1 regression shape: main + control, expect on the long-press, validates clean', () => {
    const subs = compile(ENV(), CX);
    expect(subs.map((s) => s.sub)).toEqual(['main', 'control']);
    for (const s of subs) expect(s.errors, s.sub).toEqual([]);
    const p = mainPlan();
    expect(p.actions[0]).toMatchObject({ type: 'longPress', element: 'target.link', expect: { role: 'phenomenon' } });
    expect(p.audit).toMatchObject({ version: 1, sub: 'main', understanding: { frequency: 'always' } });
    expect(p.limits).toMatchObject({ maxRounds: 30, maxMinutes: 15, untilBudget: true });
    expect(p.provenance.generatedBy).toBe('model');
    expect(p.contract?.observable.phenomenon).toMatch(/菜单不出现/);
  });
  it('R1: unknown element / Node', () => {
    const p = mainPlan();
    p.setup[0] = { ...p.setup[0], node: { name: 'teamily.openChat', input: {} } };
    expect(errorsOf(p).join()).toMatch(/unknown node teamily\.openChat/);
  });
  it('R2: a target without must', () => {
    const p = mainPlan();
    delete p.targets[1].must;
    expect(errorsOf(p).join()).toMatch(/R2 targets\.link/);
  });
  it('R4: the oracle must sit on an action with a phenomenon expect (or say why)', () => {
    const p = mainPlan();
    p.audit!.oracle.at = 'actions[1]';
    expect(errorsOf(p).join()).toMatch(/R4 oracle\.at/);
    p.audit!.oracle.atReason = '现象只能在轮末用视觉看';
    expect(errorsOf(p).join()).not.toMatch(/R4/);
  });
  it('R5: no whole-screen text check with targets; restored state needs a baseline', () => {
    const p = mainPlan();
    p.actions[0].expect!.check.scope = 'screen';
    expect(errorsOf(p).join()).toMatch(/R5 actions\[0\]\.expect/);
    const q = mainPlan();
    q.baseline = [];
    expect(errorsOf(q).join()).toMatch(/R5 baseline/);
  });
  it('R6: every restore step carries a precondition expect', () => {
    const p = mainPlan();
    delete p.afterCheck[0].expect;
    expect(errorsOf(p).join()).toMatch(/R6 afterCheck\[0\]/);
  });
  it('R10: a posting Node needs a named, allow-listed conversation', () => {
    const p = mainPlan();
    p.targets[0].guidance = 'titled "Somebody Else"';
    expect(errorsOf(p).join()).toMatch(/R10 prepare\[0\]/);
  });
  it('R12: quotes verbatim (markup / spacing tolerant), trace complete, basis known', () => {
    expect(normText('- **Frequency**: Always')).toContain(normText('Frequency: Always'));
    const p = mainPlan();
    p.audit!.quotes[0] = { id: 'q1', text: 'long-press does nothing on links' };
    expect(errorsOf(p).join()).toMatch(/R12 quotes\.q1/);
    const q = mainPlan();
    q.audit!.trace = q.audit!.trace.filter((t) => t.at !== 'actions[0]');
    expect(errorsOf(q).join()).toMatch(/R12 trace: actions\[0\]/);
    const r = mainPlan();
    r.audit!.trace[0].basis = ['q99'];
    expect(errorsOf(r).join()).toMatch(/basis "q99"/);
  });
  it('expect.check is ① only (schema)', () => {
    const p: any = JSON.parse(JSON.stringify(mainPlan()));
    p.actions[0].expect.check = { kind: 'ai', expect: 'menu', want: 'present' };
    expect(TestPlanZ.safeParse(p).success).toBe(false);
  });
  it('R3 (§9): the c7s6 plan (2063 drafted as the like template) is refused on R2 R4 R5 R6 R12', () => {
    const old = TestPlanZ.parse(JSON.parse(readFileSync('issue/__fixtures__/c7s6-plan.json', 'utf8')));
    const errs = validateAuthored(old, RAW).join('\n');
    for (const r of ['R2', 'R4', 'R5', 'R6', 'R12']) expect(errs, r).toMatch(new RegExp(`^${r} `, 'm'));
    expect(errs).toMatch(/rule-template plans are no longer drafted/);
  });
});

describe('authoring loop (§7.2)', () => {
  const answer = (xs: unknown[]) => {
    let i = 0;
    const calls: string[] = [];
    return { ask: async (_s: string, u: string) => (calls.push(u), xs[Math.min(i++, xs.length - 1)]), calls };
  };
  it('2063 → plannable draft with two sub-cases (fake model)', async () => {
    const a = answer([JSON.parse(readFileSync('issue/__fixtures__/2063-envelope.json', 'utf8'))]);
    const d = await draftIssue(ISSUE, { raw: RAW, ask: a.ask });
    expect(d.status).toBe('plannable');
    expect(d.subcases.map((s) => `${s.sub}:${s.surface}`)).toEqual(['main:android-app', 'control:android-app']);
    expect(d.subcases[0].substitution?.from).toBe('ios');
    expect(d.planVersion).toBe(1);
    expect(a.calls).toHaveLength(1);
  });
  it('validator errors go back to the model once; still failing → 无法生成计划 with the errors', async () => {
    const bad = JSON.parse(readFileSync('issue/__fixtures__/2063-envelope.json', 'utf8'));
    delete bad.subcases[0].plan.targets[1].must;
    const good = JSON.parse(readFileSync('issue/__fixtures__/2063-envelope.json', 'utf8'));
    const a = answer([bad, good]);
    expect((await draftIssue(ISSUE, { raw: RAW, ask: a.ask })).status).toBe('plannable');
    expect(a.calls[1]).toMatch(/校验错误[\s\S]*R2 targets\.link/);
    const b = answer([bad, bad]);
    const d = await draftIssue(ISSUE, { raw: RAW, ask: b.ask });
    expect(d.status).toBe('unplannable');
    expect(d.reason).toMatch(/^无法生成计划：.*R2/);
    expect(b.calls).toHaveLength(2);
  });
  it('needs-block (K5): no stand-in, the missing block is the reason', async () => {
    const e = { ...ENV(), feasibility: { status: 'needs-block', missing: [{ kind: 'node', need: '转发消息', basis: ['q1'] }] }, subcases: [] };
    const d = await draftIssue(ISSUE, { raw: RAW, ask: async () => e });
    expect(d).toMatchObject({ status: 'needs-block', subcases: [] });
    expect(d.reason).toMatch(/缺积木：node「转发消息」/);
  });
  it('no model, no template (K1): the draft says so', async () => {
    const d = await draftIssue(ISSUE, { raw: RAW, useModel: false });
    expect(d.status).toBe('unplannable');
    expect(d.reason).toMatch(/不再有规则模板/);
  });
  it('a revision is v2, must fill revision, and carries the previous delivery + evidence', async () => {
    const d1 = await draftIssue(ISSUE, { raw: RAW, ask: async () => JSON.parse(readFileSync('issue/__fixtures__/2063-envelope.json', 'utf8')) });
    const m = materialsOf({ planId: 'p', planVersion: 1, conclusion: '未复现', conclusionDetail: 'd', roundLog: [], attempts: attemptsOf(30, 2, 0) } as unknown as RunResult, 'no-hit');
    const seen: string[] = [];
    const noRev = await reviseIssue(d1, m, { raw: RAW, ask: async (_s, u) => (seen.push(u), ENV()) });
    expect(noRev!.status).toBe('unplannable');
    expect(noRev!.reason).toMatch(/revision/);
    expect(seen[0]).toMatch(/上一版（v1）的外层 JSON[\s\S]*修订原因：预算内一次都没命中/);
    const rev = { ...ENV(), revision: { from: 'v1', evidence: ['30 次 0 命中'], diagnosis: '观察位置不对', changes: ['改为读气泡下方'] } };
    const d2 = await reviseIssue(d1, m, { raw: RAW, ask: async () => rev });
    expect(d2).toMatchObject({ status: 'plannable', planVersion: 2 });
    expect(d2!.subcases[0].plan.id).toBe('2063-android-app-v2');
    expect(d2!.subcases[0].plan.audit?.revision?.diagnosis).toBe('观察位置不对');
  });
});

describe('executor pieces (§6)', () => {
  const n = (x1: number, y1: number, x2: number, y2: number, o: Partial<UiNode> = {}): UiNode => ({ x1, y1, x2, y2, text: '', desc: '', cls: 'android.view.View', clickable: false, rid: '', hint: '', ...o }) as UiNode;
  const tree = [
    n(560, 1000, 1040, 1200, { clickable: true, cls: 'android.view.ViewGroup' }),
    n(580, 1020, 1020, 1080, { text: 'https://teamily.ai/?autotest=rabc123', cls: 'android.widget.TextView' }),
    n(600, 1210, 700, 1260, { text: '👍', cls: 'android.widget.TextView' }),
    n(40, 1400, 500, 1500, { clickable: true, cls: 'android.view.ViewGroup' }),
    n(60, 1420, 480, 1480, { text: 'hello', cls: 'android.widget.TextView' }),
  ];
  it('must: sender by side, content by URL-only text, contains with {token}', () => {
    const p = { x: 800, y: 1050 };
    expect(checkMust(tree, p, { sender: 'self', content: 'link', contains: 'autotest={token}' }, 1080, 'rabc123').ok).toBe(true);
    expect(checkMust(tree, p, { sender: 'others' }, 1080, 'x').detail).toMatch(/sender self/);
    const t = checkMust(tree, { x: 200, y: 1450 }, { sender: 'self', content: 'link' }, 1080, 'x');
    expect(t.ok).toBe(false);
    expect(t.detail).toMatch(/sender others.*content text/);
  });
  it('targetBubble scope = the bubble + its reaction row; target scope is limited in x too', () => {
    expect(bubbleAt(tree, { x: 800, y: 1050 })!.below.map((x) => x.text)).toEqual(['👍']);
    const inBubble = scopeNodes(tree, { kind: 'text', expect: '', want: 'present', scope: { targetBubble: 'm' } }, { m: { x: 800, y: 1050 } }, 1080);
    expect(inBubble.map((x) => x.text).filter(Boolean)).toEqual(['https://teamily.ai/?autotest=rabc123', '👍']);
    const band = scopeNodes(tree, { kind: 'text', expect: '', want: 'present', scope: { target: 'm', within: 600, withinX: 300 } }, { m: { x: 800, y: 1050 } }, 1080);
    expect(band.some((x) => x.text === 'hello')).toBe(false);
  });
  it('expect checks are expanded with the run token like any action text', () => {
    const a = expandAction(mainPlan().actions[0], { token: 'rabc', round: 3 });
    expect(a.expect?.check).toBeDefined();
    const pc = expandAction({ type: 'tap', delayAfterMs: 0, element: 'x', expect: { role: 'precondition', check: { kind: 'text', expect: '', want: 'present', match: { contains: 'autotest={token} {round}' } } } }, { token: 'rabc', round: 3 });
    expect(pc.expect?.check.match).toEqual({ contains: 'autotest=rabc 3' });
  });
  const ctx = (plan: TestPlan): any => ({ plan, o: { runDir: mkdtempSync(join(tmpdir(), 'w3m1-')) }, log: () => {}, sess: { d: { screenshot: async () => Buffer.alloc(0) } }, res: {} });
  it('warm-up proof (§7.4): a phenomenon check that already passes before the trigger has no discrimination', async () => {
    const p = mainPlan();
    const steps: any[] = [];
    const pass = (v: boolean | null) => async (_c: unknown, k: any) => ({ check: k, pass: v, detail: `read ${v}` });
    await expect(proveChecksCanFail(ctx(p), steps, pass(true), async () => undefined)).rejects.toThrow(/检查无区分度/);
    const unread: any[] = [];
    await proveChecksCanFail(ctx(p), unread, pass(null), async () => undefined); // anchor not there yet: not a pass
    expect(unread.at(-1)).toMatchObject({ pass: null });
    void WarmupError;
    const ok: any[] = [];
    await proveChecksCanFail(ctx(p), ok, pass(false), async () => undefined);
    expect(ok.map((s) => s.action)).toEqual(['基线', '反证 actions[0]']);
    await expect(proveChecksCanFail(ctx(p), [], pass(false), async () => ({ round: 0, at: 'baseline[0]', role: 'baseline', pass: false, detail: 'menu open' }))).rejects.toThrow(/基线/);
  });
  it('control sub-case: no pre-trigger proof (its check must pass after the trigger instead)', async () => {
    const c = compile(ENV(), CX).find((s) => s.sub === 'control')!.plan!;
    expect(isControl(c)).toBe(true);
    const steps: any[] = [];
    await proveChecksCanFail(ctx(c), steps, async () => ({ check: c.checks[0], pass: true, detail: '' }) as any, async () => undefined);
    expect(steps.map((s) => s.action)).toEqual(['基线']);
  });
});

describe('evaluation + revision (§8)', () => {
  const run = (o: Partial<RunResult>) => ({ planId: '2063-android-app-v1', planVersion: 1, conclusion: '未复现', conclusionDetail: '', roundLog: [], ...o }) as RunResult;
  it('triggers: warm-up failed / must failed 3× / drift above threshold / no hit; none after a hit or for v1 plans', () => {
    expect(revisionTrigger(run({ conclusion: '计划不可执行' }))).toBe('warmup');
    expect(revisionTrigger(run({ conclusion: '执行失败', error: '目标核对连续 3 次不通过：link — sender others' }))).toBe('warmup');
    expect(revisionTrigger(run({ executability: { validated: true, warmup: 'passed', driftRate: 0.4, unstable: true } }))).toBe('drift');
    expect(revisionTrigger(run({}))).toBe('no-hit');
    expect(revisionTrigger(run({ conclusion: '已复现' }))).toBeUndefined();
    expect(revisionTrigger(run({ planVersion: undefined }))).toBeUndefined();
    expect(revisionTrigger(run({ conclusion: '执行失败', error: 'adb offline' }))).toBeUndefined();
  });
  it('materials carry warm-up steps, expect failures, must tries, drift reasons, samples', () => {
    const m = materialsOf(run({ warmup: { steps: [{ step: 1, action: 'target.link', expected: '画面变化', observed: 'Δ0', pass: false, ms: 1, expect: { role: 'phenomenon', pass: false, detail: 'no 回复' } }], checks: [] }, expectLog: [{ round: 3, at: 'actions[0]', role: 'precondition', pass: false, detail: 'x' }], mustLog: [{ id: 'link', try: 1, detail: 'content text', point: { x: 1, y: 2 } }], roundLog: [{ round: 2, step: 4, results: [{ kind: 'drift', pass: null, detail: 'baseline not met (baseline[0]): menu open' }] }], samples: ['a.png'], attempts: attemptsOf(10, 1, 0) }), 'no-hit');
    expect(m.warmup[0].observed).toMatch(/expect（phenomenon）不成立：no 回复/);
    expect(m.expectFailures.map((e) => e.at)).toEqual(['targets.link', 'actions[0]']);
    expect(m.driftReasons[0]).toMatchObject({ n: 1 });
    expect(m.samples).toEqual(['a.png']);
  });
  it('a missing block / substitution diagnosis stops revising', () => {
    expect(stopsRevising({ status: 'needs-block' } as any)).toBe('needs-block');
    expect(stopsRevising({ status: 'plannable', envelope: { revision: { diagnosis: '环境替代导致无法复现：Android 上没有预览卡片' } } } as any)).toBe('substitution');
    expect(stopsRevising({ status: 'plannable', envelope: { revision: { diagnosis: '观察位置不对' } } } as any)).toBeUndefined();
    expect(stopsRevising({ status: 'plannable', envelope: { revision: { diagnosis: '观察位置（范围）不合格，不是缺积木、也不是环境替代：…' } } } as any)).toBeUndefined();
  });
  it('wording (§8.3, K3): rate with interval and version; a miss is the plans’ miss; no upper bound', () => {
    expect(versionSentence({ conclusion: '已复现', attempts: attemptsOf(30, 0, 9), conclusionDetail: '', planVersion: 2, surface: 'android-app' })).toMatch(/^已复现：复现率 9\/30（Wilson 95% 16\.7%–47\.9%），计划 v2$/);
    const miss = versionSentence({ conclusion: '未复现', attempts: attemptsOf(30, 0, 0), conclusionDetail: '', planVersion: 3, surface: 'android-app' }, 1)!;
    expect(miss).toMatch(/^计划 v1–v3 未能复现/);
    expect(miss).not.toMatch(/上界|3\/n/);
    expect(versionSentence({ conclusion: '计划不可执行', conclusionDetail: '预热第 1 步失败', planVersion: 1, surface: 'android-app' })).toMatch(/^计划不可执行（v1）/);
    expect(codeOfConclusion('计划不可执行')).toBe('PLAN_NOT_EXECUTABLE');
  });
});

describe('Issue import (§10, §12)', () => {
  const dirs = () => {
    const d = mkdtempSync(join(tmpdir(), 'imp-'));
    return { uploadDir: join(d, 'upload'), assetsDir: join(d, 'assets') };
  };
  it('id: explicit → file name → "#<n>" → upload-<date>-<sha6>; bad ids refused', () => {
    expect(importId({ id: 'abc', markdown: '#12' })).toBe('abc');
    expect(importId({ filename: 'issue-2063.md', markdown: 'x' })).toBe('2063');
    expect(importId({ markdown: 'see #2485 for details' })).toBe('2485');
    expect(importId({ markdown: 'no number' }, new Date('2026-11-09T00:00:00Z'))).toMatch(/^upload-20261109-[0-9a-f]{6}$/);
    expect(() => importId({ id: '../etc', markdown: 'x' })).toThrow(/只能是/);
  });
  it('any format is accepted: the title is the first heading / Summary line', () => {
    expect(titleOf('<!-- source: x -->\n# Long-press does nothing\n\nbody')).toBe('Long-press does nothing');
    expect(titleOf('just one line of text')).toBe('just one line of text');
  });
  it('dry run previews; save writes; same content is a no-op; different content needs overwrite', async () => {
    const o = dirs();
    const md = '# A new problem\n\n## Severity\n- **Frequency**: Always\n';
    const pv = await importIssue({ markdown: md, id: 'zz-import-test', dryRun: true }, o);
    expect(pv).toMatchObject({ id: 'zz-import-test', exists: false, same: false, frequency: 'Always' });
    const saved = await importIssue({ markdown: md, id: 'zz-import-test' }, o);
    expect(readFileSync(saved.file, 'utf8')).toBe(md);
    process.env.AUTOTEST_UPLOAD_DIR = o.uploadDir;
    try {
      expect(await importIssue({ markdown: md, id: 'zz-import-test' }, o)).toMatchObject({ exists: true, same: true });
      await expect(importIssue({ markdown: `${md}\nmore`, id: 'zz-import-test' }, o)).rejects.toThrow(/overwrite/);
      await importIssue({ markdown: `${md}\nmore`, id: 'zz-import-test', overwrite: true }, o);
      expect(readFileSync(saved.file, 'utf8')).toMatch(/more$/);
    } finally {
      delete process.env.AUTOTEST_UPLOAD_DIR;
    }
    await expect(importIssue({ markdown: '   ' }, o)).rejects.toThrow(/为空/);
  });
  it('screenshots: blob links via the contents API, user-attachments via the signed URL, failures kept and listed', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const seen: string[] = [];
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const f = (async (url: string, init?: any) => {
      seen.push(`${url} ${init?.headers?.accept ?? ''}`);
      if (/contents\/issue-1\.jpg/.test(url)) return new Response(png, { status: 200 });
      if (/jwt=abc/.test(url)) return new Response(png, { status: 200 });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    try {
      const md = '![a](https://github.com/Teamily-Inc/bug-screenshots/blob/main/issue-1.jpg?raw=true)\n![b](https://github.com/user-attachments/assets/k1)\n![c](https://example.com/x.png)';
      const html = '<img src="https://private-user-images.githubusercontent.com/1/k1.png?jwt=abc&amp;x=1">';
      const r = await localizeImages(md, 't1', html, { fetch: f, dir: mkdtempSync(join(tmpdir(), 'as-')) });
      expect(r.images.map((x) => !!x.local)).toEqual([true, true, false]);
      expect(r.images[2].error).toMatch(/HTTP 404/);
      expect(r.markdown).toMatch(/\]\([^)]*t1\/1\.png\)/);
      expect(r.markdown).toContain('https://example.com/x.png');
      expect(seen[0]).toMatch(/api\.github\.com\/repos\/Teamily-Inc\/bug-screenshots\/contents\/issue-1\.jpg\?ref=main application\/vnd\.github\.raw/);
      expect(seen.join('\n')).not.toMatch(/test-token/);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });
  it('body limit per route: 1 MB for imports, 64 KB elsewhere; too large / bad JSON is an error, not {}', async () => {
    expect(bodyLimit('/api/v1/issues/import')).toBe(1_000_000);
    expect(bodyLimit('/api/v1/tasks')).toBe(64_000);
    await expect(readBody(Readable.from([Buffer.alloc(70_000, 'a')]), 64_000)).rejects.toThrow(BodyError);
    await expect(readBody(Readable.from(['{bad']), 64_000)).rejects.toThrow(/JSON/);
    expect(await readBody(Readable.from([JSON.stringify({ markdown: 'x'.repeat(200_000) })]), 1_000_000)).toMatchObject({ markdown: expect.any(String) });
  });
});

describe('GitHub (§11)', () => {
  it('links: issues only, PR → BAD_INPUT; ids: bare number for teamily-ai-all, <repo>-<n> otherwise', () => {
    expect(parseIssueUrl('https://github.com/Teamily-Inc/teamily-ai-all/issues/2063')).toEqual({ owner: 'Teamily-Inc', repo: 'teamily-ai-all', n: 2063 });
    expect(() => parseIssueUrl('https://github.com/Teamily-Inc/teamily-ai-all/pull/5')).toThrow(/PR/);
    expect(() => parseIssueUrl('http://example.com/x')).toThrow(/只接受/);
    expect(issueIdOf({ owner: 'Teamily-Inc', repo: 'teamily-ai-all', n: 7 })).toBe('7');
    expect(issueIdOf({ owner: 'Teamily-Inc', repo: 'other', n: 7 })).toBe('other-7');
  });
  it('401 / 403 / 404 → GITHUB_AUTH (exit 53, status 424, kind env) with a reason each', () => {
    expect(STATUS.GITHUB_AUTH).toMatchObject({ exit: 53, status: 424 });
    expect(authError(401, 'x').message).toMatch(/无效或已过期/);
    expect(authError(403, 'x').message).toMatch(/组织还没批准/);
    expect(authError(404, 'x').message).toMatch(/Issue 不存在/);
    expect(authError(401, 'x').toJSON()).toMatchObject({ code: 'GITHUB_AUTH', kind: 'env' });
  });
  it('import from a link: not on the allow list → refused; fetched → a source line first', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    try {
      await expect(importIssue({ url: 'https://github.com/someone/else/issues/1', dryRun: true })).rejects.toThrow(/白名单/);
      const f = (async () => new Response(JSON.stringify({ title: 'T', body: '## Summary\nS', body_html: '', updated_at: '2026-11-01T00:00:00Z', html_url: 'https://github.com/Teamily-Inc/teamily-ai-all/issues/99999' }), { status: 200 })) as unknown as typeof fetch;
      const d = mkdtempSync(join(tmpdir(), 'gh-'));
      const pv = await importIssue({ url: 'https://github.com/Teamily-Inc/teamily-ai-all/issues/99999' }, { fetch: f, uploadDir: d, assetsDir: d });
      expect(pv.id).toBe('99999');
      expect(readFileSync(pv.file, 'utf8')).toMatch(/^<!-- source: https:\/\/github\.com\/Teamily-Inc\/teamily-ai-all\/issues\/99999 · updated_at 2026-11-01T00:00:00Z · fetched_at .+ -->\n# T\n/);
      const unauthorized = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
      await expect(importIssue({ url: 'https://github.com/Teamily-Inc/teamily-ai-all/issues/1' }, { fetch: unauthorized })).rejects.toMatchObject({ code: 'GITHUB_AUTH' });
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });
});


describe('fixes from the first real runs (2026-11-09)', () => {
  it('a prepare check cannot scope to a target frozen after prepare', () => {
    const p = mainPlan();
    p.prepareCheck = { kind: 'text', expect: 'sent', want: 'present', match: { contains: '{token}' }, scope: { target: 'link', within: 250 } };
    expect(validatePlan(p).errors.join()).toMatch(/frozen only after prepare/);
  });
  it('a list of prepare checks and a "page/region" region are normalised', () => {
    const e = ENV();
    const pc = { kind: 'text', expect: 'sent', match: { contains: '{token}' }, scope: { message: '{token}' } };
    (e.subcases[0].plan as any).prepareCheck = [pc, { ...pc, expect: 'second' }];
    (e.subcases[0].plan as any).afterCheck[0].expect.check = { kind: 'visual-region', expect: 'chat', page: 'chat', region: 'chat/composer' };
    const p = compile(e, CX)[0].plan!;
    expect(p.prepareCheck?.expect).toBe('sent');
    expect(p.prepareChecks.map((k) => k.expect)).toEqual(['second']);
    expect(p.afterCheck[0].expect?.check).toMatchObject({ page: 'chat', region: 'composer' });
  });
  it('"Mobile app (iOS / Android - build not specified)" names both phone apps; the App surface is preferred', async () => {
    const { detectPlatforms } = await import('./parse');
    expect(detectPlatforms('Mobile app (iOS / Android - exact build not specified), compared against web')).toEqual(['ios', 'android', 'web']);
    const { surfaceOf } = await import('./planner');
    expect(surfaceOf({ platforms: ['android', 'web'] } as any, { surfaces: ['android-app', 'desktop-web'] } as any).surface).toBe('android-app');
    expect(surfaceOf({ platforms: ['web'] } as any, { surfaces: ['desktop-web'] } as any).surface).toBe('desktop-web');
  });
  it('a precondition the plan did not establish is revised (not blamed on the environment)', () => {
    expect(revisionTrigger({ planVersion: 1, conclusion: '执行失败', conclusionDetail: '', error: '前置条件未建立（x）— y' } as any)).toBe('warmup');
  });
});

describe('control sub-case (2063 v2 control run)', () => {
  it('no hit = 对照组正常, not a miss; a control hit triggers revision, a clean control does not', () => {
    const r = { planId: '2063-control-android-app-v2', planVersion: 2, conclusion: '未复现', conclusionDetail: '', attempts: attemptsOf(30, 0, 0), surface: 'android-app' } as any;
    expect(versionSentence(r)).toMatch(/^对照组正常：30 次有效尝试检查全部通过（计划 v2）/);
    expect(revisionTrigger(r)).toBeUndefined();
    expect(revisionTrigger({ ...r, conclusion: '已复现' })).toBe('control-hit');
    expect(versionSentence({ ...r, conclusion: '已复现', attempts: attemptsOf(30, 0, 3) })).toMatch(/^对照组异常/);
  });
});

describe('teamily.relogin (user 2026-11-09: App logout + pool-account re-login allowed)', () => {
  it('is in the catalog as a lifecycle block; allowed in the loop on android-app, refused on web', () => {
    expect(blockCatalog()).toContain('`teamily.relogin` [phase: lifecycle]');
    const p = mainPlan();
    p.actions.push({ type: 'node', node: { name: 'teamily.relogin', input: {} }, delayAfterMs: 0 });
    expect(validatePlan(p).errors).toEqual([]);
    const w = { ...mainPlan(), surface: 'desktop-web' as const };
    w.actions = [{ type: 'node', node: { name: 'teamily.relogin', input: {} }, delayAfterMs: 0 }];
    expect(validatePlan(w).errors.join()).toMatch(/android-app only/);
  });
});

describe('must.sender with a full-width row container (2063 v3 run)', () => {
  const n = (x1: number, y1: number, x2: number, y2: number, o: Partial<UiNode> = {}): UiNode => ({ x1, y1, x2, y2, text: '', desc: '', cls: 'android.view.View', clickable: false, rid: '', hint: '', ...o }) as UiNode;
  it('own message = content hugs the right edge, whatever the row width', () => {
    const row = n(0, 1900, 1080, 2200, { clickable: true, cls: 'android.view.ViewGroup' });
    const own = [row, n(168, 1910, 1052, 2190, { cls: 'android.view.ViewGroup' }), n(200, 2000, 1000, 2060, { text: 'https://www.figma.com/?t=r5f1c18' })];
    expect(checkMust(own, { x: 539, y: 2058 }, { sender: 'self', content: 'link', contains: 'r5f1c18' }, 1080, 'x')).toMatchObject({ ok: true });
    const theirs = [row, n(20, 1910, 130, 2020, { cls: 'android.widget.ImageView' }), n(150, 1910, 800, 2190), n(170, 2000, 780, 2060, { text: 'hello' })];
    expect(checkMust(theirs, { x: 539, y: 2058 }, { sender: 'others' }, 1080, 'x').ok).toBe(true);
  });
});

describe('multi-client Issues on one phone (user 2026-11-09: alternating logins, no web runs)', () => {
  it('relogin takes as: self | other; a phone + web Issue runs on the App', async () => {
    const p = mainPlan();
    p.actions.push({ type: 'node', node: { name: 'teamily.relogin', input: { as: 'other' } }, delayAfterMs: 0 });
    expect(validatePlan(p).errors).toEqual([]);
    p.actions[1] = { type: 'node', node: { name: 'teamily.relogin', input: { as: 'someone' } }, delayAfterMs: 0 };
    expect(validatePlan(p).errors.join()).toMatch(/teamily\.relogin input/);
    const { surfaceOf } = await import('./planner');
    const s = surfaceOf({ platforms: ['ios', 'web', 'desktop'] } as any, { surfaces: ['desktop-web'] } as any);
    expect(s.surface).toBe('android-app');
    expect(s.subst?.reason).toMatch(/交替登录/);
    expect(userPrompt(CX)).toMatch(/teamily\.relogin \{as: "other"\}/);
  });
});
