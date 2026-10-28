import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scrub, TdaiSessionSink, Trajectory } from './trajectory';

const summary = { runId: 'r1', query: 'Issue 2044', startedAt: '2026-10-26T10:00:00.000Z', endedAt: '2026-10-26T10:01:00.000Z', model: 'm', account: 'prod-aaron1', output: { conclusion: '已复现' } };

describe('trajectory', () => {
  it('writes JSONL, scrubs credential-like fields', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'traj-')), 'trajectory.jsonl');
    const t = new Trajectory(f);
    t.emit('op', { op: 'tap', password: 'x' });
    t.emit('verdict', { conclusion: 'c' });
    const lines = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(['op', 'verdict']);
    expect(lines[0].password).toBeUndefined();
    expect(scrub({ a: { apiKey: 1, b: 2 } })).toEqual({ a: { b: 2 } });
  });
  it('a sink failure never throws into the run', async () => {
    const t = new Trajectory(join(mkdtempSync(join(tmpdir(), 'traj-')), 'x.jsonl'), [{ emit: () => { throw new Error('boom'); }, close: async () => { throw new Error('boom'); } }]);
    expect(() => t.emit('op', {})).not.toThrow();
    await expect(t.close(summary)).resolves.toBeUndefined();
  });
  it('maps a run onto TDAI /v3/session/add (headers carry identity; only allowed top-level fields)', async () => {
    const s = new TdaiSessionSink('http://127.0.0.1:9');
    s.emit({ t: 'x', kind: 'op' });
    const r = s.request(summary);
    expect(r.url).toBe('http://127.0.0.1:9/v3/session/add');
    expect(r.headers['x-tdai-session-id']).toBe('r1');
    expect(Object.keys(r.body).sort()).toEqual(['ended_at', 'messages', 'model', 'output', 'source', 'started_at', 'user_query']);
    await expect(s.close(summary)).resolves.toBeUndefined(); // gateway down: no throw
  });
});
