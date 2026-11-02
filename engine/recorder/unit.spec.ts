// Pure-function checks for evidence review and video alignment.
import { describe, expect, it } from 'vitest';
import { type ReplayFile, videoTimeOf } from './bundle';
import { pickWindows, tally } from './evidence-review';
import type { CoordOp } from './recording-driver';

const op = (round: number, at: number, label: string, o: Partial<CoordOp> = {}): CoordOp => ({ step: round * 2, round, at, durationMs: 50, op: 'tap', point: { x: 1, y: 2 }, label, ...o });

describe('video alignment', () => {
  it('maps host time onto the merged recording across segments (gaps between segments are not in the video)', () => {
    const segs = [
      { startedAt: 10_000, endedAt: 40_000, durationSec: 29 },
      { startedAt: 41_000, endedAt: 50_000, durationSec: 8 },
    ];
    expect(videoTimeOf(segs, 15_000)).toBe(5);
    expect(videoTimeOf(segs, 43_000)).toBe(31); // 29 s of segment 1 + 2 s into segment 2
    expect(videoTimeOf([{ startedAt: 1000, endedAt: 5000 }], 3000)).toBe(2); // older bundles: wall time
  });
});

describe('evidence review', () => {
  const replay = {
    targets: [{ id: 'link', point: { x: 1, y: 1 }, chosen: 'quote of "x"' }],
    rounds: [
      { round: 1, ops: [op(1, 20_000, 'target.link'), op(1, 26_000, 'after:chat.back'), op(1, 27_000, 'after:teamily.openConversation')] },
      { round: 2, ops: [op(2, 29_000, 'target.link'), op(2, 29_600, 'wait', { op: 'wait' })] },
    ],
    incidentRound: 2,
  } as unknown as ReplayFile;
  const meta = { triggeredAt: new Date(35_000).toISOString(), detail: 'x', video: [{ startedAt: 10_000, endedAt: 30_000, durationSec: 20 }], videoSeconds: 20 };

  it('shows the previous round (reference) and the flagged round around their action, labelled', () => {
    const w = pickWindows(replay, meta);
    expect(w.map((x) => [x.sec, x.toSec])).toEqual([
      [7.5, 14.05], // round 1: 2.5 s before the tap … 4 s after it (before the restore steps at 16 s)
      [16.5, 19.95], // round 2: … up to the end of the recording
    ]);
    expect(w[0].label).toMatch(/previous round \(looked normal to the check — reference\) 1/);
    expect(w[1].label).toMatch(/FLAGGED round 2.*tap target\.link \(quote of "x"\)/);
    expect(w[1].count).toBe(5);
  });
  it('re-bases a trimmed preset clip and clamps to its length', () => {
    const w = pickWindows(replay, { ...meta, clipStartSec: 6, videoSeconds: 12 });
    expect(w[0].sec).toBe(1.5);
    expect(w[1].toSec).toBe(11.95);
  });
  it('a restore step ends the round strip early (the restore is not part of the evidence)', () => {
    const r2 = { ...replay, rounds: [replay.rounds[0]], incidentRound: 1 } as ReplayFile;
    const w = pickWindows(r2, { ...meta, video: [{ startedAt: 10_000, endedAt: 30_000, durationSec: 20 }] });
    expect(w[0].toSec).toBe(14.05);
    const early = { ...r2, rounds: [{ round: 1, ops: [op(1, 20_000, 'target.link'), op(1, 22_000, 'after:chat.back')] }] } as ReplayFile;
    expect(pickWindows(early, meta)[0].toSec).toBe(11.9);
  });
  it('majority of decided votes; a tie or no decided vote is unverified', () => {
    const v = (c: boolean | null) => ({ consistent: c, observed: '', reason: '' });
    expect(tally([v(false), v(false)])).toBe('inconsistent');
    expect(tally([v(true), v(false), v(true)])).toBe('consistent');
    expect(tally([v(true), v(false)])).toBe('unverified');
    expect(tally([v(null)])).toBe('unverified');
  });
});
