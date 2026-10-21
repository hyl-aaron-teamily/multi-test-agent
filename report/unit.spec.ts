// Problem report: a platform task's report must contain only that task's own artifact.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExploreTrace } from '../explore/trace';
import type { MonkeySummary } from '../monkey/loop';
import { buildProblemReport } from './problem-report';

const monkey: MonkeySummary = {
  package: 'com.example.monkey',
  source: 'monkey',
  deviceId: 'dev1',
  startedAt: '2026-10-21T00:00:00.000Z',
  finishedAt: '2026-10-21T00:01:00.000Z',
  throttle: 300,
  rounds: [],
  conclusion: 'no crash',
  reproduceCommands: [],
};
const trace = {
  package: 'com.example.explore',
  source: 'ai-explore',
  steps: [],
  stateCount: 1,
  crashes: [],
  truncated: false,
  truncatedReason: null,
  midsceneReport: null,
  conclusion: 'no crash',
} as unknown as ExploreTrace;

describe('problem report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'problem-report-'));
  afterAll(() => rm(dir, { recursive: true, force: true }));
  const m = join(dir, 'summary.json');
  const t = join(dir, 'trace.json');
  await writeFile(m, JSON.stringify(monkey));
  await writeFile(t, JSON.stringify(trace));

  it('--only monkey leaves path A out entirely', async () => {
    const md = await readFile(await buildProblemReport({ trace: null, monkey: m, out: join(dir, 'm.md') }), 'utf8');
    expect(md).toContain('# 通用测试问题报告 — com.example.monkey\n');
    expect(md).toContain('## 路径 B');
    expect(md).not.toContain('路径 A');
    expect(md).not.toContain('com.example.explore');
  });

  it('--only explore leaves path B out entirely', async () => {
    const md = await readFile(await buildProblemReport({ trace: t, monkey: null, out: join(dir, 'e.md') }), 'utf8');
    expect(md).toContain('# 通用测试问题报告 — com.example.explore\n');
    expect(md).toContain('## 路径 A');
    expect(md).not.toContain('路径 B');
  });

  it('both paths still render together when both are given', async () => {
    const md = await readFile(await buildProblemReport({ trace: t, monkey: m, out: join(dir, 'b.md') }), 'utf8');
    expect(md).toContain('com.example.explore / com.example.monkey');
    expect(md).toContain('## 路径 A');
    expect(md).toContain('## 路径 B');
  });
});
