import { describe, expect, it } from 'vitest';
import { decodePng, dHash, encodePng, hamming, type Rgba, regionDiffFraction } from '../core/image';
import { classifyLogLine } from '../drivers/android';
import { opsSrt } from '../incident/bundle';
import { firstDeviation } from './replay';
import { applyApproval, splitSubcases, substitutionOptions, templateFor } from '../issue/planner';
import { validatePlan } from '../issue/validate';
import { regionMatch } from './checks';
import { ruleChoice } from './targets';
import { featureConclusion, VerdictTracker } from './verdict';

const blank = (w: number, h: number, v = 255): Rgba => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) });
const ink = (img: Rgba, x0: number, y0: number, w: number, h: number) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set([20, 20, 20, 255], (y * img.width + x) * 4);
};

describe('lifecycle plan rules', () => {
  const base = {
    id: 'x', issueRef: 'x', title: 'x', category: 'bug-intermittent', issueSurfaces: [], env: 'prod', setup: [], checks: [],
    limits: { maxSteps: 10, maxMinutes: 5, maxIntervalMs: 1000 }, verdictRule: { anyHit: true }, provenance: { generatedBy: 'manual', skillVersion: 'x' },
  };
  it('exit / kill only on app surfaces; idle needs ms ≤ 10 min; wait stays ≤ 1 s', () => {
    const ok = validatePlan({ ...base, surface: 'android-app', actions: [{ type: 'exitApp' }, { type: 'idle', value: '60000' }, { type: 'killApp' }, { type: 'launch' }] });
    expect(ok.errors).toEqual([]);
    const web = validatePlan({ ...base, surface: 'desktop-web', actions: [{ type: 'killApp' }] });
    expect(web.errors.join()).toMatch(/killApp needs an app surface/);
    const bad = validatePlan({ ...base, surface: 'android-web', actions: [{ type: 'idle', value: '900000' }, { type: 'wait', value: '5000' }] });
    expect(bad.errors.join()).toMatch(/idle needs a value/);
    expect(bad.errors.join()).toMatch(/wait ≤ 1000/);
  });
});

describe('verdict rule', () => {
  it('intermittent: one hit reproduces', () => {
    const t = new VerdictTracker({ anyHit: true });
    expect(t.record(false)).toBe(false);
    expect(t.record(true)).toBe(true);
    expect(t.conclusion()).toBe('已复现');
  });
  it('always: needs 3 consecutive hits, a miss resets', () => {
    const t = new VerdictTracker({ consecutiveHits: 3 });
    for (const h of [true, true, false, true, true]) expect(t.record(h)).toBe(false);
    expect(t.record(true)).toBe(true);
    // W2-2 §3.2: no "fixed" wording — a run that did not reproduce is 未复现 (with its attempts).
    expect(new VerdictTracker({ consecutiveHits: 3 }).conclusion()).toBe('未复现');
  });
  it('feature conclusion', () => {
    expect(featureConclusion([{ pass: true }, { pass: true }])).toBe('已实现');
    expect(featureConclusion([{ pass: false }, { pass: false }])).toBe('未实现');
    expect(featureConclusion([{ pass: true }, { pass: false }])).toBe('部分实现');
    expect(featureConclusion([{ pass: null }])).toBe('执行失败');
  });
});

describe('image', () => {
  it('png round trip + hash', () => {
    const a = blank(40, 30);
    ink(a, 5, 5, 10, 10);
    const b = decodePng(encodePng(a));
    expect(b.width).toBe(40);
    expect(hamming(dHash(a), dHash(b))).toBe(0);
  });
  it('ink matcher: blank area never matches a region with text; sliding finds a moved region', () => {
    const ref = blank(100, 200);
    ink(ref, 10, 50, 40, 8);
    const box: [number, number, number, number] = [0, 45, 100, 20];
    expect(regionDiffFraction(blank(100, 200), ref, box)).toBe(1);
    expect(regionDiffFraction(ref, ref, box)).toBe(0);
    const moved = blank(100, 200);
    ink(moved, 10, 30, 40, 8);
    expect(regionMatch(moved, ref, box, 1, 40).fraction).toBe(0);
    expect(regionMatch(moved, ref, box, 1, 0).fraction).toBe(1);
  });
});

describe('android anomaly gate (logcat only)', () => {
  const pkg = 'ai.teamily.mobile';
  it('crash / anr / death / left app / app error', () => {
    expect(classifyLogLine('10-21 E AndroidRuntime: FATAL EXCEPTION: main', pkg)?.kind).toBe('crash');
    // another process (hierarchy dump) or another pid is not the app's crash
    expect(classifyLogLine('10-26 18:31:00.052 28649 28660 E AndroidRuntime: FATAL EXCEPTION: UiAutomation', pkg, 4321)).toBeUndefined();
    expect(classifyLogLine('10-26 18:31:00.052 28649 28660 E AndroidRuntime: FATAL EXCEPTION: main', pkg, 4321)).toBeUndefined();
    expect(classifyLogLine('10-26 18:31:00.052 4321 4330 E AndroidRuntime: FATAL EXCEPTION: main', pkg, 4321)?.kind).toBe('crash');
    expect(classifyLogLine('I am_crash: [123,0,ai.teamily.mobile,1,java.lang.RuntimeException]', pkg)?.kind).toBe('crash');
    expect(classifyLogLine('E ActivityManager: ANR in ai.teamily.mobile (ai.teamily.mobile/.MainActivity)', pkg)?.kind).toBe('anr');
    expect(classifyLogLine('I am_proc_died: [0,4321,ai.teamily.mobile,0,17]', pkg)?.kind).toBe('app-exit');
    expect(classifyLogLine('I wm_set_resumed_activity: [0,com.miui.home/.launcher.Launcher,startHomeActivity]', pkg)?.kind).toBe('left-app');
    expect(classifyLogLine('I wm_set_resumed_activity: [0,ai.teamily.mobile/.MainActivity,x]', pkg)).toBeUndefined();
    const e = classifyLogLine('10-21 1 4321 4400 E ReactNativeJS: TypeError: undefined is not a function', pkg, 4321, /TypeError/);
    expect(e?.kind).toBe('app-error');
    expect(e?.suspect).toBe(true);
  });
});

describe('preparation rules', () => {
  const c = (title: string, preview = '') => ({ title, preview, box: [0, 0, 10, 10] as [number, number, number, number] });
  it('group / other / muted fallbacks', () => {
    const cands = [c("x's Personal AI"), c('A, B, C'), c('Bob'), c('Team, X', '[有人@你] hi | [muted]')];
    expect(ruleChoice('group-conversation', cands, [])).toBe(1);
    expect(ruleChoice('other-conversation', cands, [1])).toBe(2);
    expect(ruleChoice('muted-group', cands, [])).toBe(3);
  });
});

describe('planner', () => {
  it('splits (1)(2)(3) sub-cases', () => {
    const s = splitSubcases({ summary: 'Issues: (1) like gives no feedback; (2) link jumps to old message; (3) keyboard needs two taps.' } as any);
    expect(s.map((x) => x.sub)).toEqual(['s1', 's2', 's3']);
  });
  it('iOS → substitution options with a reason; web → none', () => {
    expect(substitutionOptions(['ios'])?.alternatives).toEqual(['android-app', 'mobile-web']);
    expect(substitutionOptions(['web'])).toBeUndefined();
  });
  it('templates validate against the SKILL vocabulary', () => {
    for (const [text, cat] of [['typing @ picker does not open', 'bug-intermittent'], ['three separate bell notification entries', 'feature'], ['mention aggregated list @', 'feature'], ['keyboard needs a tap', 'bug-intermittent'], ['like not shown', 'bug-intermittent']] as const) {
      const t = templateFor(text, cat, 'desktop-web');
      const plan = { id: 'x', issueRef: '1', title: t.title, category: cat, surface: 'desktop-web', issueSurfaces: ['web'], env: 'prod', targets: t.targets, setup: t.setup, actions: t.actions, checks: t.checks, acceptance: t.acceptance, limits: { maxSteps: 1000, maxMinutes: 30, maxIntervalMs: 1000 }, verdictRule: { anyHit: true }, provenance: { generatedBy: 'rules', skillVersion: 'x' } };
      expect(validatePlan(plan).errors, text).toEqual([]);
    }
  });
  it('approval keeps only ticked sub-cases and records the substitution', () => {
    const plan: any = { id: '1329-s1-android-app-v1', surface: 'android-app', title: 't', targets: [], setup: [], actions: [], checks: [], provenance: { generatedBy: 'rules', skillVersion: 'x' } };
    const d: any = { subcases: ['s1', 's2', 's3'].map((sub) => ({ sub, surface: 'android-app', plan: { ...plan, id: plan.id.replace('s1', sub) }, substitution: { from: 'ios', to: 'android-app', reason: 'r', alternatives: [] } })) };
    const out = applyApproval(d, [{ sub: 's1' }, { sub: 's3', surface: 'mobile-web' }]);
    expect(out.map((p) => p.id)).toEqual(['1329-s1-android-app-v1', '1329-s3-mobile-web-v1']);
    expect(out[1].substitution).toEqual({ from: 'ios', to: 'mobile-web', reason: 'r' });
    expect(out[0].provenance.confirmedAt).toBeTruthy();
  });
});

describe('replay + bundle', () => {
  it('first deviating round', () => {
    expect(firstDeviation(['0000000000000000', 'ffffffffffffffff'], ['0000000000000000', '0000000000000000'])).toEqual({ index: 1, distance: 64 });
    expect(firstDeviation(['0000000000000000'], ['0000000000000001'])).toBeUndefined();
  });
  it('ops.srt timing relative to the video start', () => {
    const srt = opsSrt([{ step: 3, round: 1, at: 61_500, durationMs: 200, op: 'tap', point: { x: 1, y: 2 }, label: 'chat.composer' }], 0);
    expect(srt).toMatch(/00:01:01,500 --> 00:01:01,900/);
    expect(srt).toMatch(/#3 r1 tap \(1,2\) chat.composer/);
  });
});
