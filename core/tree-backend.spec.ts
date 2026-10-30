import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./adb', () => ({ adb: vi.fn(async () => '<hierarchy><node text="ua" bounds="[0,0][1,1]" /></hierarchy>') }));

const { percentiles, readTree, setTreeBackend, treeBackendOf, treeReportLines, treeStats } = await import('./tree-backend');

describe('core/tree-backend', () => {
  beforeEach(() => {
    treeStats.reads = {};
    treeStats.fallbacks = [];
    setTreeBackend('d1', undefined);
  });
  it('reads through uiautomator by default', async () => {
    const r = await readTree('d1');
    expect(r.backend).toBe('uiautomator');
    expect(r.fallback).toBeUndefined();
    expect(treeBackendOf('d1')).toBe('uiautomator');
  });
  it('uses the selected backend when it answers', async () => {
    setTreeBackend('d1', { name: 'a11y-service', dump: async () => '<hierarchy><node text="svc" bounds="[0,0][1,1]" /></hierarchy>' });
    const r = await readTree('d1');
    expect(r.backend).toBe('a11y-service');
    expect(r.xml).toContain('svc');
    expect(treeStats.reads['a11y-service'].n).toBe(1);
  });
  it('falls back to uiautomator with a reason when the backend fails or returns nothing', async () => {
    setTreeBackend('d1', { name: 'a11y-service', dump: async () => { throw new Error('ECONNREFUSED 127.0.0.1'); } });
    const r = await readTree('d1');
    expect(r.backend).toBe('uiautomator');
    expect(r.fallback).toMatch(/a11y-service: ECONNREFUSED/);
    setTreeBackend('d1', { name: 'a11y-service', dump: async () => '<hierarchy/>' });
    expect((await readTree('d1')).fallback).toMatch(/empty hierarchy/);
    expect(treeStats.fallbacks).toHaveLength(2);
    expect(treeReportLines().join('\n')).toMatch(/退回 uiautomator 2 次/);
  });
  it('percentiles', () => {
    expect(percentiles([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, p95: 5 });
    expect(percentiles([])).toEqual({ n: 0, p50: 0, p95: 0 });
  });
});
