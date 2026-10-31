// W2-4 T6 acceptance: start `scripts/mcp.ts` over stdio like an IDE does, list the tools and resources, call
// every read-only tool, and compare each result with `autotest <command> --json` field by field (every field
// the CLI prints must be equal in the MCP result; MCP may add retryable / kind to an error).
//   npx tsx scripts/mcp-check.ts [--out docs/w2m4/mcp-check.json]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tsx = resolve('node_modules/tsx/dist/cli.mjs');

/** Pure: paths where `cli` differs from `mcp` (fields only in `mcp` are allowed). */
export function diffFields(cli: unknown, mcp: unknown, path = ''): string[] {
  if (cli === null || typeof cli !== 'object') return Object.is(cli, mcp) ? [] : [`${path || '.'}: ${JSON.stringify(cli)} ≠ ${JSON.stringify(mcp)}`];
  if (mcp === null || typeof mcp !== 'object' || Array.isArray(cli) !== Array.isArray(mcp)) return [`${path || '.'}: type differs`];
  const out: string[] = [];
  if (Array.isArray(cli) && cli.length !== (mcp as unknown[]).length) out.push(`${path}: length ${cli.length} ≠ ${(mcp as unknown[]).length}`);
  for (const k of Object.keys(cli as object)) out.push(...diffFields((cli as any)[k], (mcp as any)[k], `${path}.${k}`));
  return out;
}

function cliJson(command: string, argv: string[]): unknown {
  const r = spawnSync(process.execPath, [tsx, 'bin/autotest.ts', ...command.split(' '), ...argv, '--json'], { encoding: 'utf8', timeout: 180_000 });
  return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? 'null');
}

async function main() {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
  const client = new Client({ name: 'autotest-mcp-check', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, resolve('scripts/mcp.ts')], stderr: 'ignore' }));
  const tools = (await client.listTools()).tools;
  const templates = (await client.listResourceTemplates()).resourceTemplates;
  console.log(`tools (${tools.length}): ${tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? '' : '*'}`).join(', ')}`);
  console.log(`resource templates: ${templates.map((t) => t.uriTemplate).join(', ')}`);

  // Arguments for read-only calls come from the listings themselves.
  const issues = cliJson('issue list', []) as { data?: { id: string; plans?: { id: string }[] }[] };
  const withPlan = issues.data?.find((i) => i.plans?.length);
  const tasks = cliJson('task list', ['--limit', '5']) as { data?: { id: string; state: string }[] };
  const doneTask = tasks.data?.find((t) => !['queued', 'waiting-env', 'preflight', 'running', 'finishing', 'recovering'].includes(t.state));
  const envs = cliJson('env list', []) as { data?: { id: string }[] };
  const calls: [string, Record<string, unknown>, string[]][] = [
    ['issue list', {}, []],
    ['env list', {}, []],
    ['doctor', {}, []],
    ...(withPlan ? ([['issue show', { id: withPlan.id }, [withPlan.id]], ['draft show', { id: withPlan.id }, [withPlan.id]], ['plan explain', { planId: withPlan.plans![0].id }, [withPlan.plans![0].id]]] as [string, Record<string, unknown>, string[]][]) : []),
    ...(envs.data?.[0] ? ([['env show', { envId: envs.data[0].id }, [envs.data[0].id]]] as [string, Record<string, unknown>, string[]][]) : []),
    ...(doneTask ? ([['task status', { taskId: doneTask.id }, [doneTask.id]], ['result show', { taskId: doneTask.id }, [doneTask.id]], ['task wait', { taskId: doneTask.id, timeout: 5 }, [doneTask.id, '--timeout', '5']]] as [string, Record<string, unknown>, string[]][]) : []),
    ['issue show', { id: 'no-such-issue' }, ['no-such-issue']],
  ];
  const rows: { tool: string; code: string; exit: number; isError: boolean; diffs: string[] }[] = [];
  for (const [command, args, argv] of calls) {
    const name = command.replace(/ /g, '_');
    const r = (await client.callTool({ name, arguments: args })) as { structuredContent?: any; isError?: boolean };
    const cli = cliJson(command, argv);
    const diffs = diffFields(cli, r.structuredContent);
    rows.push({ tool: name, code: r.structuredContent?.code, exit: r.structuredContent?.exit, isError: !!r.isError, diffs });
    console.log(`${diffs.length ? '✗' : '✓'} ${name} → ${r.structuredContent?.code} (${r.structuredContent?.exit})${r.isError ? ' isError' : ''}${diffs.length ? `\n    ${diffs.slice(0, 5).join('\n    ')}` : ''}`);
  }
  // device_snapshot (no CLI twin): OK with nodes and an image when exactly one idle phone is online.
  const snap = (await client.callTool({ name: 'device_snapshot', arguments: { maxNodes: 50 } })) as { structuredContent?: any; content?: { type: string }[]; isError?: boolean };
  const extra: Record<string, unknown> = { device_snapshot: { code: snap.structuredContent?.code, summary: snap.structuredContent?.summary, nodes: snap.structuredContent?.data?.nodes?.length, image: !!snap.content?.some((c) => c.type === 'image') } };
  console.log(`${snap.structuredContent?.code === 'OK' ? '✓' : '·'} device_snapshot → ${snap.structuredContent?.code}: ${snap.structuredContent?.summary}`);
  if (doneTask) {
    for (const uri of [`autotest://results/${doneTask.id}`, `autotest://reports/${doneTask.id}`]) {
      const r = await client.readResource({ uri }).then(
        (x) => `${x.contents[0]?.mimeType} ${String((x.contents[0] as any)?.text ?? '').length} chars`,
        (e) => `error: ${(e as Error).message.slice(0, 80)}`,
      );
      extra[uri] = r;
      console.log(`· resource ${uri} → ${r}`);
    }
  }
  const outside = await client.readResource({ uri: 'autotest://files/..%2F.env' }).then(
    () => 'READ (bad)',
    () => 'refused',
  );
  extra['autotest://files/../.env'] = outside;
  console.log(`${outside === 'refused' ? '✓' : '✗'} resource outside the roots (../.env) → ${outside}`);
  await client.close();
  const ok = rows.every((r) => !r.diffs.length) && outside === 'refused';
  console.log(`${ok ? 'OK' : 'MISMATCH'}: ${rows.filter((r) => !r.diffs.length).length}/${rows.length} identical to --json`);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), tools: tools.map((t) => ({ name: t.name, readOnly: !!t.annotations?.readOnlyHint, args: Object.keys((t.inputSchema as any)?.properties ?? {}) })), templates: templates.map((t) => t.uriTemplate), rows, extra }, null, 2));
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('mcp-check.ts')) main();
