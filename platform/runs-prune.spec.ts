import { mkdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from '../core/testing/tmp-dir';
import { isConclusion, pruneRuns, runKey } from './runs-prune';

const DAY = 86_400_000;
const now = Date.parse('2026-11-13T00:00:00Z');

function mk(root: string, rel: string, ageDays: number, result?: unknown) {
  const p = join(root, rel);
  mkdirSync(p, { recursive: true });
  if (result) writeFileSync(join(p, 'result.json'), JSON.stringify(result));
  writeFileSync(join(p, 'x.bin'), 'x');
  const t = (now - ageDays * DAY) / 1000;
  utimesSync(p, t, t);
  return p;
}

describe('platform/runs-prune (midscene_run retention)', () => {
  it('run keys drop timestamps and task ids', () => {
    expect(runKey('1329-2026-10-21T12-02-35-739Z')).toBe('1329');
    expect(runKey('1903-t-20261030132748-sdal-2026-10-30T13-27-51-844Z')).toBe('1903');
    expect(runKey('android-app-t-20261106033606-zmpg')).toBe('android-app');
    expect(runKey('2026-10-22T06-03-08-922Z')).toBe('(none)');
  });

  it('conclusions: reproduced anywhere in the result, or counted findings', () => {
    expect(isConclusion({ results: [{ conclusion: '已复现（3 / 5）' }] })).toBe('reproduced');
    expect(isConclusion({ agent: { findings: [{ counted: true }] } })).toBe('findings');
    expect(isConclusion({ agent: { findings: [{ counted: false }] } })).toBeUndefined();
    expect(isConclusion({ conclusion: '未复现' })).toBeUndefined();
  });

  it('keeps recent, newest per key, reproduced, findings and referenced runs; deletes the rest', () => {
    const root = tmpDir('prune-');
    for (let i = 1; i <= 5; i++) mk(root, `issues/1329-2026-10-0${i}T00-00-00-000Z`, 40 - i, { conclusion: '未复现' });
    const repro = mk(root, 'issues/1329-2026-09-01T00-00-00-000Z', 60, { results: [{ conclusion: '已复现' }] });
    const refd = mk(root, 'issues/1329-2026-09-02T00-00-00-000Z', 59);
    const recent = mk(root, 'issues/2063-2026-11-10T00-00-00-000Z', 3);
    const found = mk(root, 'explore/android-app-t-20261020000000-aaaa', 20, { agent: { findings: [{ counted: true }] } });
    for (const n of ['b1', 'b2', 'b3', 'b4']) mk(root, `explore/android-app-t-2026101500000${n.slice(1)}-${n}xx`, 25, { agent: { findings: [] } });
    const bench = mk(root, 'bench/aw-1', 90);
    mk(root, 'report/old.html', 30);
    const r = pruneRuns({ root, now, refText: 'see midscene_run/issues/1329-2026-09-02T00-00-00-000Z', apply: true });
    // 1329: the 3 newest of 5 plain runs stay, the 2 oldest go; reproduced and referenced stay. explore: the 3 newest stay, 2 go. report/old.html goes.
    expect(r.delete).toHaveLength(5);
    for (const p of [repro, refd, recent, found, bench]) expect(existsSync(p)).toBe(true);
    expect(existsSync(join(root, 'issues/1329-2026-10-01T00-00-00-000Z'))).toBe(false);
    expect(existsSync(join(root, 'report'))).toBe(false);
    expect(r.failed).toEqual([]);
  });

  it('dry run deletes nothing', () => {
    const root = tmpDir('prune-');
    const p = mk(root, 'report/old.html', 30);
    const r = pruneRuns({ root, now, refText: '' });
    expect(r.delete).toHaveLength(1);
    expect(existsSync(p)).toBe(true);
  });
});
