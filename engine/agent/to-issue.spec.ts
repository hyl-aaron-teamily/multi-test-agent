import { describe, expect, it } from 'vitest';
import { classifyRules } from '../../issue/classify';
import { parseIssue } from '../../issue/parse';
import type { AgentResult, Finding } from './run';
import { findingIssue, stepWords } from './to-issue';

const f: Finding = { n: 1, source: 'hard', kind: 'app-exit', description: 'app-exit: am_kill … stop ai.teamily.mobile', step: 7, screen: 'abc', incident: 'midscene_run/explore/x/incidents/1-app-exit', counted: true, path: ['tap #54 "发现"', 'tap #5 "动态"', 'swipe up', 'back'] };
const r = { goal: '浏览发现页', mode: 'explore', surface: 'android-app', runDir: 'midscene_run/explore/x', startedAt: '2026-11-03T01:17:20.503Z', findings: [f] } as unknown as AgentResult;

describe('exploration finding → Issue draft', () => {
  it('turns agent steps into plain words', () => {
    expect(f.path.map(stepWords)).toEqual(['点「发现」', '点「动态」', '上滑', '返回']);
    expect(stepWords('tap (100,200) the bell')).toBe('点屏幕位置 (100, 200)（the bell）');
    expect(stepWords('wait 3000ms')).toBe('等待 3 秒');
  });

  it('writes the sample Issue sections, so the usual classify / plan path reads it', () => {
    const i = parseIssue('explore-1', findingIssue(r, f));
    expect(i.summary).toMatch(/探索发现/);
    expect(i.steps).toEqual(['打开 Teamily，登录后停在首页', '点「发现」', '点「动态」', '上滑', '返回', '观察当前界面']);
    expect(i.actual).toMatch(/app-exit/);
    expect(i.platforms).toContain('android');
    expect(i.frequency).toBe('Intermittent');
    expect(classifyRules(i).category).toBe('bug-intermittent');
  });
});
