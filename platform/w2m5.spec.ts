// W2-5 (device-free): android-web plans that cannot run there, frame statistics, incidental findings in the
// result view and as Issue drafts, SKILL candidates.
import { describe, expect, it } from 'vitest';
import { CandidateTracker } from '../engine/agent/candidates';
import { incidentalIssue } from '../engine/agent/to-issue';
import type { RunResult } from '../engine/plan/run';
import { parseGfxinfo } from '../engine/stats';
import type { ScreenNode } from '../core/screen-index';
import { wasSearchBox } from '../engine/agent/risk';
import { classifyRisk } from '../engine/agent/risk';
import { surfaceUnfit } from './plans-v1';
import { resultRun } from './views';

const GFX = `Stats since: 123ns
Total frames rendered: 1200
Janky frames: 84 (7.00%)
50th percentile: 9ms
90th percentile: 17ms
95th percentile: 25ms
99th percentile: 61ms`;

describe('W2-5 quick tier hardening and incidental findings', () => {
  it('android-web: a plan that freezes @ picker members is not applicable there, with the reason', () => {
    const prepare = [{ node: { name: 'teamily.freezeMention', input: { member: 'a', as: 'member' } } }] as any;
    expect(surfaceUnfit({ surface: 'android-web', prepare })).toMatch(/android-web 不适用.*@ 选择器/);
    expect(surfaceUnfit({ surface: 'android-app', prepare })).toBeUndefined();
    expect(surfaceUnfit({ surface: 'android-web', prepare: [] })).toBeUndefined();
  });

  it('frame statistics from dumpsys gfxinfo (metric only)', () => {
    expect(parseGfxinfo(GFX)).toEqual({ totalFrames: 1200, jankyFrames: 84, jankyPercent: 7, p50Ms: 9, p90Ms: 17, p95Ms: 25, p99Ms: 61 });
    expect(parseGfxinfo('No process found for: ai.teamily.mobile')).toBeUndefined();
  });

  it('incidental findings: listed in the run view (also when there are none), never in the conclusion; → Issue draft', () => {
    const run = { planId: '1903/main:android-app@v1', title: '气泡内 @', surface: 'android-app', conclusion: '未复现', conclusionDetail: '3 次有效尝试', hits: [], runTag: 'r-1', incidental: [{ n: 1, round: 10, step: 60, kind: 'error-text', description: '界面上出现报错提示「发送失败」', incident: 'midscene_run/x/incidents/1-visual-anomaly', review: 'consistent', counted: true }] } as unknown as RunResult;
    const v = resultRun(run);
    expect(v.conclusion).toBe('未复现');
    expect(v.incidental).toEqual([{ n: 1, round: 10, kind: 'error-text', description: '界面上出现报错提示「发送失败」', incident: 'midscene_run/x/incidents/1-visual-anomaly', review: 'consistent', counted: true }]);
    expect(resultRun({ ...run, incidental: undefined } as RunResult).incidental).toEqual([]);
    const md = incidentalIssue(run, run.incidental![0]);
    expect(md).toMatch(/## Summary\n\[附带发现\] 界面上出现报错提示「发送失败」（android-app，运行 1903\/main:android-app@v1 第 10 轮后）/);
    expect(md).toMatch(/deterministic detector error-text, evidence review consistent; seen once, not part of that run's verdict/);
  });

  it('SKILL candidates: same page, text and place seen ≥ 3 times; counts and times are left out', () => {
    const n = (text: string, x = 100, y = 100): ScreenNode => ({ text, desc: '', rid: '', cls: 'android.widget.Button', clickable: true, box: [x - 20, y - 10, 40, 20], center: { x, y } });
    const t = new CandidateTracker();
    for (const step of [1, 2, 3]) t.see(step, 'home', [n('发现'), n('12:30', 200, 50), n(`${step} 条新消息`, 300, 300)]);
    t.see(4, 'home', [n('设置', 400, 400)]);
    const list = t.list();
    expect(list.map((c) => [c.page, c.meaning, c.count, c.shot])).toEqual([['home', '发现', 3, 'steps/0001.png']]);
  });

  it('search box typed into: still the search box seen there before (W2-5 §7.4)', () => {
    const seen: [number, number, number, number][] = [[40, 120, 800, 90]];
    expect(wasSearchBox([40, 120, 800, 90], seen)).toBe(true);
    expect(wasSearchBox([40, 1900, 800, 90], seen)).toBe(false);
    expect(classifyRisk({ type: 'type', label: '1', text: '12' }, false, { searchBox: true }).blocked).toBe(false);
    expect(classifyRisk({ type: 'type', label: '1', text: '12' }, false).blocked).toBe(true);
  });
});
