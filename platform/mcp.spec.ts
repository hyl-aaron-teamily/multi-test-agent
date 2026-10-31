import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../scripts/cli-v1';
import { argvOf, EXPOSED, inputShape, isToolError, safeResourcePath, toolName, toolResult, WAIT_MAX_S } from './mcp';

const cmd = (c: string) => COMMANDS.find((x) => x.command === c)!;

describe('platform/mcp (W2-4 §5)', () => {
  it('exposes the §5.1 commands, not env recover / offline; ≤ 20 tools with device_snapshot', () => {
    expect(EXPOSED).not.toContain('env recover');
    expect(EXPOSED).not.toContain('env offline');
    expect(EXPOSED.every((c) => COMMANDS.some((x) => x.command === c))).toBe(true);
    expect(EXPOSED.length + 1).toBeLessThanOrEqual(20);
    expect(toolName('plan explain')).toBe('plan_explain');
  });
  it('input schema from the CLI arg specs (required / optional, no --json)', () => {
    const s = inputShape(cmd('task run'));
    expect(Object.keys(s)).toEqual(['planId', 'env', 'series', 'max-rounds', 'hash', 'dry-run', 'idempotency-key']);
    expect(s.planId.safeParse(undefined).success).toBe(false);
    expect(s.series.safeParse(undefined).success).toBe(true);
    expect(s.series.safeParse(1.5).success).toBe(false);
  });
  it('arguments → the same argv the CLI parses; task wait capped at 25 s', () => {
    expect(argvOf(cmd('task run'), { planId: '2010/main:android-app@v1', series: 3, 'dry-run': true })).toEqual(['2010/main:android-app@v1', '--series', '3', '--dry-run', '--json']);
    expect(argvOf(cmd('task wait'), { taskId: 't1', timeout: 600 })).toEqual(['t1', '--timeout', String(WAIT_MAX_S), '--json']);
    expect(argvOf(cmd('task wait'), { taskId: 't1' })).toEqual(['t1', '--timeout', String(WAIT_MAX_S), '--json']);
  });
  it('outcomes and 20/21 are results; ≥ 30 are tool errors with status / code / hint / retryable', () => {
    expect([0, 10, 11, 17, 20, 21].map((exit) => isToolError({ exit }))).toEqual([false, false, false, false, false, false]);
    expect([1, 30, 41, 54, 60].map((exit) => isToolError({ exit }))).toEqual([true, true, true, true, true]);
    const r = toolResult({ status: 503, code: 'PLATFORM_DOWN', exit: 54, summary: '平台服务未启动', error: { message: '连不上', hint: '先启动平台：pnpm platform' } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 'PLATFORM_DOWN', exit: 54, error: { status: 503, code: 'PLATFORM_DOWN', hint: '先启动平台：pnpm platform', retryable: true } });
    const a = toolResult({ status: 403, code: 'APPROVAL_REQUIRED', exit: 30, summary: '需要人在 Web 同意', error: { message: 'x', hint: 'http://localhost:3210/review' } });
    expect(a.structuredContent).toMatchObject({ error: { hint: 'http://localhost:3210/review', retryable: false, kind: 'policy' } });
    const ok = toolResult({ status: 202, code: 'STILL_RUNNING', exit: 21, summary: '仍在运行', text: 'not in JSON' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).not.toHaveProperty('text');
  });
  it('resources stay inside midscene_run/ and skills/teamily/refs/', () => {
    expect(safeResourcePath('../.env')).toBeUndefined();
    expect(safeResourcePath('..%2F..%2Fpackage.json')).toBeUndefined();
    expect(safeResourcePath('package.json')).toBeUndefined();
  });
});

describe('docs/agent-rules.md matches the tool table (W2-4 T7)', () => {
  it('lists every MCP tool, and only those', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync('docs/agent-rules.md', 'utf8');
    const listed = [...doc.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...EXPOSED.map(toolName), 'device_snapshot'].sort());
  });
  it('--print-config gives a snippet with absolute paths and the rules file for each client', async () => {
    const { printConfig } = await import('../scripts/mcp');
    for (const c of ['claude', 'cursor', 'codex', 'vscode']) {
      const t = printConfig(c, 'D:/repo');
      expect(t).toMatch(/mcp\.ts/);
      expect(t).toMatch(/agent-rules\.md/);
    }
    expect(printConfig('x')).toMatch(/unknown client/);
  });
});

describe('MCP: sensitive plans stay Web-only (§7.6, full access off)', () => {
  it('task_run / plan_approve for a sensitive series → 30, isError, review link in hint', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mcp30-'));
    process.env.AUTOTEST_STATE_DIR = dir;
    process.env.AUTOTEST_POLICY_FILE = join(dir, 'no-policy.yaml');
    try {
      const { apiV1 } = await import('./api-v1');
      const { consentConfig, moveEnv, registerEnv } = await import('./lifecycle/env');
      const { resolvePlan } = await import('./plans-v1');
      const ENV = 'android-app:4f2ebdf2@prod';
      registerEnv({ id: ENV, surface: 'android-app', serviceEnv: 'prod', device: '4f2ebdf2', udid: '4f2ebdf2', package: 'ai.teamily.mobile', configItems: [{ id: 'taplus', what: 'taplus', why: 'w', restore: 'r' }] });
      moveEnv(ENV, 'checking', { by: 't', basis: 'x' });
      moveEnv(ENV, 'ready', { by: 't', basis: 'x' });
      consentConfig(ENV, 'taplus', 'aaron');
      const id = `2010/main:android-app@v${(await import('./plans-v1')).savedDraft('2010')?.version ?? 1}`;
      const call = (method: string, path: string, body: any = {}) => apiV1({ method, path: `/api/v1${path}`, query: new URLSearchParams(), body, web: false }, {});
      const run = toolResult((await call('POST', '/tasks', { planId: id, series: 21 })) as any);
      expect(run.isError).toBe(true);
      expect(run.structuredContent).toMatchObject({ code: 'APPROVAL_REQUIRED', exit: 30, error: { kind: 'policy', retryable: false, hint: expect.stringMatching(/plan\.html/) } });
      const ap = toolResult((await call('POST', `/plans/${encodeURIComponent(id)}/approve`, { hash: resolvePlan(id).hash, series: 21 })) as any);
      expect(ap.structuredContent).toMatchObject({ code: 'APPROVAL_REQUIRED', exit: 30 });
    } finally {
      delete process.env.AUTOTEST_STATE_DIR;
      delete process.env.AUTOTEST_POLICY_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
