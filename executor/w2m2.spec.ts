// W2-2 pure pieces: attempts + Wilson / 3/n, failure classification, preflight parsing, run-marker
// templates, newest-message scope, and the 2010 / 1903 plans passing the validator.
import { describe, expect, it } from 'vitest';
import type { UiNode } from '../core/ui-tree';
import { validatePlan } from '../issue/validate';
import { DEFAULT_LIMITS } from '../platform/schema/test-plan';
import { patternById } from '../skills/teamily/patterns';
import { classifyFailure } from './failure';
import { messageNodes, scopeNodes, textMatches } from './observe';
import { parseDeviceState, taplusWith } from './preflight';
import { attemptsOf, attemptsText, wilson } from './stats';
import { expand, expandAction, expandCheck, newRunToken } from './template';
import { seriesMarkdown, summarizeSeries } from './series';
import { taskArgs, validateTaskInput } from '../platform/tasks';

describe('attempts (W2-2 §3.1)', () => {
  it('Wilson 95% interval', () => {
    const [lo, hi] = wilson(3, 10);
    expect(lo).toBeCloseTo(0.1078, 3);
    expect(hi).toBeCloseTo(0.6032, 3);
    expect(wilson(0, 0)).toEqual([0, 1]);
    expect(wilson(10, 10)[1]).toBe(1);
  });
  it('0 hits: 3/n upper bound, no "fixed" wording', () => {
    const a = attemptsOf(73, 4, 0);
    expect(a).toMatchObject({ rounds: 77, valid: 73, drift: 4, hits: 0, rate: 0 });
    expect(a.upper95).toBeCloseTo(0.0411, 3);
    const t = attemptsText(a);
    expect(t).toMatch(/73 次有效尝试未复现；单次复现概率 95% 上界 ≈ 4\.1%/);
    expect(t).toMatch(/4 轮操作偏离/);
    expect(t).not.toMatch(/修复/);
  });
  it('hits: rate with the Wilson interval; no attempts → says so', () => {
    expect(attemptsText(attemptsOf(6, 0, 3))).toMatch(/6 次有效尝试中命中 3 次；单轮命中率 50%（Wilson 95% 区间 18\.8%–81\.2%）/);
    expect(attemptsText(attemptsOf(0, 5, 0))).toMatch(/0 次有效尝试/);
  });
});

describe('failure classification (W2-2 §3.3)', () => {
  it('preflight → env; warm-up / stale SKILL → tool', () => {
    expect(classifyFailure('环境不合格', 'screen: locked').kind).toBe('env');
    expect(classifyFailure('计划不可执行', 'x').kind).toBe('tool');
    expect(classifyFailure('SKILL 失效', 'x').kind).toBe('tool');
  });
  it('error text and device snapshot decide env vs tool', () => {
    expect(classifyFailure('执行失败', 'adb: device offline').rule).toBe('device-offline');
    expect(classifyFailure('执行失败', 'net::ERR_INTERNET_DISCONNECTED at …').rule).toBe('network');
    expect(classifyFailure('执行失败', 'teamily.quoteReply: the message menu (引用 / 回复) did not open')).toMatchObject({ kind: 'tool', rule: 'default' });
    expect(classifyFailure('执行失败', 'teamily.quoteReply: menu did not open', { focus: 'Window{1 u0 NotificationShade}', pkg: 'ai.teamily.mobile' }).kind).toBe('env');
    expect(classifyFailure('执行失败', 'x', { wakefulness: 'Asleep' }).rule).toBe('screen-off');
    expect(classifyFailure('执行失败', 'x', { focus: 'Window{2 u0 com.miui.contentextension/…Taplus}', pkg: 'ai.teamily.mobile' }).kind).toBe('env');
    expect(classifyFailure('执行失败', 'x', { focus: 'Window{3 u0 ai.teamily.mobile/ai.teamily.mobile.MainActivity}', pkg: 'ai.teamily.mobile', wakefulness: 'Awake', keyguard: false }).kind).toBe('tool');
  });
});

describe('preflight parsing (W2-2 §4.2)', () => {
  const out = `  mWakefulness=Awake
  mCurrentFocus=Window{8c72859 u0 ai.teamily.mobile/ai.teamily.mobile.MainActivity}
    isKeyguardShowing=false
  AC powered: false
  USB powered: true
  level: 12
Active default network: 114
  NetworkAgentInfo{network{102}  handle{4}  ni{MOBILE[LTE] CONNECTED extra: ims} created=2026
  NetworkAgentInfo{network{114}  handle{4}  ni{WIFI CONNECTED extra: } created=2026
    mInputShown=true
ime=com.iflytek.inputmethod.miui/.FlyIME
stayon=0
taplus={"taplus_blacklist":["com.android.contacts"]}`;
  it('reads screen, battery, default network, IME, keyboard, settings', () => {
    expect(parseDeviceState(out)).toMatchObject({ wakefulness: 'Awake', keyguard: false, battery: 12, charging: true, network: 'wifi', ime: 'com.iflytek.inputmethod.miui/.FlyIME', keyboard: true, stayOn: 0 });
    expect(parseDeviceState('Active default network: none').network).toBe('none');
    expect(parseDeviceState('  mCurrentFocus=Window{14cee4a u0 NotificationShade}\n    isKeyguardShowing=true').keyguard).toBe(true);
  });
  it('Taplus blacklist gets the app once', () => {
    expect(JSON.parse(taplusWith('{"taplus_blacklist":["a"]}', 'ai.teamily.mobile')!).taplus_blacklist).toEqual(['a', 'ai.teamily.mobile']);
    expect(taplusWith('{"taplus_blacklist":["ai.teamily.mobile"]}', 'ai.teamily.mobile')).toBeUndefined();
    expect(taplusWith('garbage{', 'p')).toBeUndefined();
  });
});

describe('run marker templates (W2-2 §4.3)', () => {
  it('fresh marker r + 6 hex; {token} / {round} expanded in text, node input, requires and checks', () => {
    expect(newRunToken()).toMatch(/^r[0-9a-f]{6}$/);
    const v = { token: 'r3fa9c1', round: 2 };
    expect(expand('autotest-2010 {token} {round}', v)).toBe('autotest-2010 r3fa9c1 2');
    const a = expandAction({ type: 'require', requires: { composerHas: 'x {token}' }, delayAfterMs: 0 }, v);
    expect(a.requires).toEqual({ composerHas: 'x r3fa9c1' });
    expect(expandAction({ type: 'node', node: { name: 'teamily.sendMessage', input: { text: 'q {token}' } }, delayAfterMs: 0 }, v).node?.input).toEqual({ text: 'q r3fa9c1' });
    const k = expandCheck({ kind: 'text', scope: { message: 'autotest-1903 {token} {round}' }, match: { exact: '@aaron+test2' }, expect: 'e', want: 'present' }, v);
    expect(k.scope).toEqual({ message: 'autotest-1903 r3fa9c1 2' });
  });
});

const n = (x1: number, y1: number, x2: number, y2: number, o: Partial<UiNode> = {}): UiNode => ({ x1, y1, x2, y2, text: '', hint: '', desc: '', cls: 'android.view.View', clickable: false, ...o });

describe('newest message / composer scope', () => {
  // Two rounds of the same run in the chat, the newest at the bottom; the composer holds a draft with the marker.
  const nodes = [
    n(189, 1600, 1031, 1666, { clickable: true, cls: 'android.view.ViewGroup' }),
    n(189, 1600, 983, 1666, { text: 'autotest-1903 r1 1 @aaron+test2', cls: 'android.widget.TextView' }),
    n(676, 1600, 948, 1666, { desc: '@aaron+test2', clickable: true }),
    n(189, 1923, 1031, 1989, { clickable: true, cls: 'android.view.ViewGroup' }),
    n(189, 1923, 983, 1989, { text: 'autotest-1903 r1 2 @aaron+test2', cls: 'android.widget.TextView' }),
    n(58, 2128, 1024, 2212, { text: 'autotest-1903 r1 3 ', cls: 'android.widget.EditText', clickable: true }),
  ];
  it('takes the bottom-most message carrying the anchor (never the composer) with its bubble', () => {
    const m = messageNodes(nodes, 'autotest-1903 r1 2')!;
    expect(m.map((x) => x.text || x.desc)).toEqual(['', 'autotest-1903 r1 2 @aaron+test2']);
    expect(messageNodes(nodes, 'autotest-1903 r1 3')).toBeUndefined();
    expect(messageNodes(nodes, 'autotest-1903 r1 1')!.some((x) => x.desc === '@aaron+test2')).toBe(true);
  });
  it('composer scope is the input; text matching is exact / contains', () => {
    expect(scopeNodes(nodes, { kind: 'text', scope: 'composer', expect: '', want: 'present' }, {}, 1080)).toHaveLength(1);
    expect(textMatches('autotest-2010 r1 1', { exact: 'autotest-2010 r1 1' })).toBe(true);
    expect(textMatches('Treat "autotest-2010 r1 1" as a label', { exact: 'autotest-2010 r1 1' })).toBe(false);
  });
});

describe('2010 / 1903 plans', () => {
  const plan = (id: string, params: Record<string, unknown> = {}) => {
    const f = patternById(id)!.build('android-app', params);
    const { maxRounds, ...frag } = f;
    return { id: `x-${id}`, issueRef: 'x', category: 'bug-always', surface: 'android-app', issueSurfaces: ['ios'], env: 'prod', prepare: [], afterCheck: [], ...frag, limits: { ...DEFAULT_LIMITS, maxRounds }, verdictRule: { consecutiveHits: 3 }, provenance: { generatedBy: 'rules', skillVersion: 'x' } };
  };
  it('composer-rewrite validates: require in the loop, exact composer check, 6 rounds', () => {
    const v = validatePlan(plan('composer-rewrite'));
    expect(v.errors).toEqual([]);
    expect(v.plan!.limits.maxRounds).toBe(6);
    expect(v.plan!.actions.map((a) => a.node?.name ?? a.type)).toEqual(['teamily.clearComposer', 'type', 'require', 'teamily.tapRewrite']);
  });
  it('mention-render validates: the frozen member row is a known target', () => {
    const v = validatePlan(plan('mention-render', { conversation: 'G', member: 'aaron+test2' }));
    expect(v.errors).toEqual([]);
    expect(v.plan!.epilogue?.check.scope).toEqual({ message: 'autotest-1903 {token}' });
  });
  it('require outside the loop is rejected', () => {
    const p: any = plan('composer-rewrite');
    p.setup.push({ type: 'require', requires: { composerHas: 'x' }, delayAfterMs: 0 });
    expect(validatePlan(p).errors.join()).toMatch(/loop actions only/);
  });
});

describe('series (W2-2 §3.4)', () => {
  const mk = (conclusion: string, valid: number, hits: number, extra: Record<string, unknown> = {}) => ({ conclusion, attempts: attemptsOf(valid, 0, hits), stats: { durationSec: 60 }, phases: { loop: 1000 * valid, preflight: 800 }, runTag: 'r000001', ...extra }) as any;
  it('reliability excludes 环境不合格; failures grouped by kind; pooled attempts', () => {
    const runs = [
      { index: 1, dir: 'd/run-01', result: mk('已复现', 3, 3) },
      { index: 2, dir: 'd/run-02', result: mk('已复现', 4, 3) },
      { index: 3, dir: 'd/run-03', result: { conclusion: '环境不合格', failure: { kind: 'env', rule: 'preflight', reason: 'screen: locked' }, stats: { durationSec: 3 } } as any },
      { index: 4, dir: 'd/run-04', result: { conclusion: '执行失败', failure: { kind: 'tool', rule: 'default', reason: 'x' }, stats: { durationSec: 9 } } as any },
    ];
    const s = summarizeSeries(runs);
    expect(s).toMatchObject({ total: 4, envUnfit: 1, counted: 3, reachedLoop: 2, validRuns: 2, reproducedRuns: 2 });
    expect(s.pooled).toMatchObject({ valid: 7, hits: 6 });
    expect(s.failures.map((f) => `${f.kind}:${f.rule}:${f.n}`).sort()).toEqual(['env:preflight:1', 'tool:default:1']);
    expect(s.phaseMedians.preflight).toBe(800);
    const md = seriesMarkdown({ issue: '2010', sub: 'main', surface: 'android-app', env: 'prod', runs, dir: 'd', startedAt: 'a', finishedAt: 'b' });
    expect(md).toMatch(/走到循环 2 \/ 3（67%，目标 ≥ 90%：\*\*未达标\*\*）；环境不合格 1 次/);
    expect(md).toMatch(/\[报告\]\(run-01\/report\.md\)/);
  });
  it('no hit anywhere: 未复现 with the pooled 3/n bound', () => {
    const md = seriesMarkdown({ issue: '1903', sub: 'main', surface: 'android-app', env: 'prod', runs: [1, 2].map((i) => ({ index: i, dir: `d/run-0${i}`, result: mk('未复现', 6, 0) })), dir: 'd', startedAt: 'a', finishedAt: 'b' });
    expect(md).toMatch(/未复现（本系列 12 次有效尝试）/);
    expect(md).toMatch(/上界 ≈ 25%/);
  });
  it('series task: exactly one sub-case, runs 1..50', () => {
    expect(validateTaskInput({ type: 'series', issue: '2010', approve: 'main:android-app', runs: 10, maxRounds: 6 })).toMatchObject({ type: 'series', runs: 10, maxRounds: 6 });
    expect(validateTaskInput({ type: 'series', issue: '2010', approve: 's1,s2' })).toMatch(/exactly one/);
    expect(validateTaskInput({ type: 'series', issue: '2010', approve: 'main', runs: 99 })).toMatch(/runs/);
    const t = { ...(validateTaskInput({ type: 'series', issue: '2010', approve: 'main:android-app', runs: 3 }) as any), id: 'T1' };
    expect(taskArgs(t, '4f2e')).toEqual(['bin/autotest.ts', 'series', '--issue', '2010', '--approve', 'main:android-app', '--env', 'prod', '--id', 'T1', '--runs', '3', '--device', '4f2e']);
  });
});
