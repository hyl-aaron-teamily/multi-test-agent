// Pure-function checks for instant replay.
import { describe, expect, it } from 'vitest';
import { sliceFromLastLaunch } from './ops';
import { ScreenRecorder } from './screen-recorder';

describe('replay', () => {
  it('slices ops from the last launch and rebases time', () => {
    const steps = [
      { at: '2026-10-20T10:00:00.000Z', action: 'cold', ok: true, op: { kind: 'launch' as const, cold: true } },
      { at: '2026-10-20T10:00:05.000Z', action: 'a', ok: true, op: { kind: 'aiTap' as const, locate: 'x' } },
      { at: '2026-10-20T10:01:00.000Z', action: 'warm', ok: true, op: { kind: 'launch' as const, cold: false } },
      { at: '2026-10-20T10:01:04.000Z', action: 'check', ok: true },
      { at: '2026-10-20T10:01:10.000Z', action: 'b', ok: false, op: { kind: 'aiAct' as const, prompt: 'send' } },
    ];
    const r = sliceFromLastLaunch(steps);
    expect(r.map((x) => x.label)).toEqual(['warm', 'b']); // checks have no op and are skipped
    expect(r.map((x) => x.t)).toEqual([0, 10_000]);
    expect(r[1].ok).toBe(false);
  });

  it('falls back to device screenrecord when forced', () => {
    expect(new ScreenRecorder({ workDir: '.', engine: 'screenrecord' }).engine).toBe('screenrecord');
  });
});
