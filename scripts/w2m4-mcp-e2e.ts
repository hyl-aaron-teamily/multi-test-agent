// W2-4 §7.6 / §7.7: one Issue end to end through MCP tools only (stdio, like an IDE):
//   doctor → draft_create → plan_explain → task_run → task_wait (repeated) → result_show
// then the same result through `autotest result show --json` (field by field) for consistency.
//   npx tsx scripts/w2m4-mcp-e2e.ts --issue 2010 [--surface android-app] [--series 3] [--no-model] [--out docs/w2m4/mcp-e2e-2010.json]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { diffFields } from './mcp-check';

const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const issue = arg('issue') ?? '2010';
const surface = arg('surface') ?? 'android-app';
const series = Number(arg('series') ?? 1);
const out = arg('out');
const tsx = resolve('node_modules/tsx/dist/cli.mjs');

async function main() {
  const client = new Client({ name: 'w2m4-mcp-e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, resolve('scripts/mcp.ts')], stderr: 'ignore' }));
  const log: { tool: string; args: Record<string, unknown>; code: string; exit: number; summary: string; at: string }[] = [];
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 })) as { structuredContent?: any };
    const e = r.structuredContent;
    log.push({ tool, args, code: e.code, exit: e.exit, summary: String(e.summary).slice(0, 200), at: new Date().toISOString() });
    console.log(`${tool}(${JSON.stringify(args)}) → ${e.code} ${e.exit}: ${String(e.summary).slice(0, 160)}`);
    return e;
  };
  const save = (extra: Record<string, unknown>) => {
    if (!out) return;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ issue, surface, series, log, ...extra }, null, 2));
  };

  const doc = await call('doctor');
  if (doc.data?.conclusion === 'blocked') return save({ stopped: 'doctor: blocked' });
  const draft = await call('draft_create', { id: issue, env: 'prod', ...(process.argv.includes('--no-model') ? { 'no-model': true } : {}) });
  const planId = (draft.data?.plans as string[] | undefined)?.find((p) => p.includes(`:${surface}@`));
  if (!planId) return save({ stopped: `no ${surface} plan in the draft` });
  const plan = await call('plan_explain', { planId, series });
  console.log(`  plan: ${plan.data?.summary}\n  impact: ≤ ${plan.data?.impact?.messagesMax} messages to ${plan.data?.impact?.conversations?.join(', ')}; approval ${plan.data?.approval?.category} / ${plan.data?.approval?.state}`);
  const run = await call('task_run', { planId, series, hash: plan.data?.hash });
  if (run.code === 'APPROVAL_REQUIRED') return save({ stopped: '30: needs a person on the Web', link: run.error?.hint });
  const taskId = run.data?.id;
  if (!taskId) return save({ stopped: `task_run ${run.code}` });
  let w = await call('task_wait', { taskId });
  let waits = 1;
  while (w.code === 'STILL_RUNNING') {
    w = await call('task_wait', { taskId });
    waits++;
  }
  const result = await call('result_show', { taskId });
  await client.close();
  const cliOut = spawnSync(process.execPath, [tsx, 'bin/autotest.ts', 'result', 'show', taskId, '--json'], { encoding: 'utf8' }).stdout.trim().split('\n').at(-1)!;
  const diffs = diffFields(JSON.parse(cliOut), result);
  console.log(`task_wait called ${waits}×; result: ${result.summary}\nMCP vs --json: ${diffs.length ? `MISMATCH\n  ${diffs.slice(0, 8).join('\n  ')}` : 'identical'}`);
  save({ planId, taskId, waits, result, cliDiffs: diffs });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
