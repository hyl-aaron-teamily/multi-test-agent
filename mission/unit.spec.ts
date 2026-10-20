// Pure-function checks for the mission layer (no device / model needed).
import { describe, expect, it } from 'vitest';
import { extractJson, LIMIT_CAPS, normalisePlan, rulePlan } from './planner';
import { verdictOf } from './report';
import { HARD_BLOCK, parseGfxinfo } from './runner';

describe('mission planner', () => {
  it('keyword planner maps the three typical requests', () => {
    expect(rulePlan('聊天时偶发闪退，你试试能不能重现')).toMatchObject({ intent: 'reproduce', targetArea: '聊天页' });
    expect(rulePlan('排查下消息列表的问题')).toMatchObject({ intent: 'investigate', targetArea: '消息列表' });
    expect(rulePlan('左侧栏新加了个功能，看看使用流畅度和功能完整性')).toMatchObject({ intent: 'evaluate', targetArea: '左侧栏', measureJank: true });
  });

  it('clamps model-suggested limits to platform caps and fills gaps', () => {
    const p = normalisePlan({ intent: 'reproduce', maxSteps: 99999, maxMinutes: -3, scenario: [] }, '聊天闪退', 'model');
    expect(p.maxSteps).toBe(LIMIT_CAPS.maxSteps);
    expect(p.maxMinutes).toBe(1);
    expect(p.scenario.length).toBeGreaterThan(0);
    expect(p.plannedBy).toBe('model');
  });

  it('extracts JSON from fenced model output', () => {
    expect(extractJson('sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('no json')).toBeUndefined();
  });
});

describe('mission runner helpers', () => {
  it('parses dumpsys gfxinfo', () => {
    const out = 'Total frames rendered: 240\nJanky frames: 96 (40.00%)\n90th percentile: 32ms\n99th percentile: 150ms\n';
    expect(parseGfxinfo(out)).toEqual({ totalFrames: 240, jankyFrames: 96, jankyPercent: 40, p90Ms: 32, p99Ms: 150 });
    expect(parseGfxinfo('nothing')).toBeUndefined();
  });

  it('hard-blocks only payment confirmation and logout', () => {
    expect(HARD_BLOCK.test('确认支付')).toBe(true);
    expect(HARD_BLOCK.test('退出登录')).toBe(true);
    expect(HARD_BLOCK.test('发送')).toBe(false);
    expect(HARD_BLOCK.test('编辑资料')).toBe(false);
  });

  it('verdict says "not reproduced" honestly', () => {
    expect(verdictOf({ findings: [], stopReason: 'max-minutes', steps: [] })).toContain('未复现');
  });
});
