import { describe, expect, it } from 'vitest';
import type { Driver, Point } from '../drivers/types';
import { RecordingDriver } from '../incident/recording-driver';
import type { Profile } from '../skills/profile';
import { execAction, resolvePoint } from './actions';
import { actionIntervals } from './stats';

const profile = { name: 'p', viewport: { width: 1000, height: 2000 }, elements: { 'chat.composer': { page: 'chat', box: [100, 1800, 800, 100], selfCheck: 'pass' } } } as unknown as Profile;

function fake(): Driver & { calls: string[] } {
  const calls: string[] = [];
  const rec = (n: string) => async (...a: unknown[]) => void calls.push(`${n} ${JSON.stringify(a)}`);
  return { surface: 'android-app', calls, launch: rec('launch'), tap: rec('tap'), longPress: rec('longPress'), type: rec('type'), key: rec('key'), swipe: rec('swipe'), scroll: rec('scroll'), back: rec('back'), screenshot: async () => Buffer.alloc(0), drainAnomalies: () => [], close: async () => {} } as any;
}

describe('executor/actions', () => {
  it('resolves elements through the profile and targets through the frozen points', () => {
    expect(resolvePoint('chat.composer', profile, {})).toEqual({ x: 500, y: 1850 });
    expect(resolvePoint('target.msg', profile, { msg: { x: 1, y: 2 } })).toEqual({ x: 1, y: 2 });
    expect(() => resolvePoint('target.none', profile, {})).toThrow(/not frozen/);
  });
  it('executes tap / type / scroll by coordinates only', async () => {
    const d = fake();
    const targets: Record<string, Point> = {};
    const ctx = { driver: d, profile, targets };
    await execAction({ type: 'tap', element: 'chat.composer', delayAfterMs: 0 }, ctx, profile, targets);
    await execAction({ type: 'type', value: 'hi', delayAfterMs: 0 }, ctx, profile, targets);
    await execAction({ type: 'scroll', value: 'up', delayAfterMs: 0 }, ctx, profile, targets);
    expect(d.calls).toEqual(['tap [{"x":500,"y":1850}]', 'type ["hi"]', 'scroll [{"x":500,"y":1000},-800]']);
  });
  it('action intervals skip lifecycle ops and the step into afterCheck', async () => {
    const r = new RecordingDriver(fake());
    r.round = 1;
    const ops = [
      { op: 'tap', at: 0, round: 1, label: 'a' },
      { op: 'tap', at: 900, round: 1, label: 'b' },
      { op: 'idle', at: 1000, round: 1, label: 'idle' },
      { op: 'tap', at: 9000, round: 1, label: 'after:x' },
      { op: 'tap', at: 9500, round: 2, label: 'c' },
    ] as any;
    expect(actionIntervals(ops)).toEqual([900]);
    expect(r.round).toBe(1);
  });
});
