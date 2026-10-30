// Native MCP service (W2-4 §5, K4): the same commands as `autotest <object> <action> --json`, as MCP tools
// over stdio. Tools are generated from the CLI command table (scripts/cli-v1.ts#COMMANDS — names, argument
// types, docs) and call the CLI's own dispatch(), so a tool result carries exactly the envelope `--json`
// prints. Not exposed: env recover / env offline (people only), help (tools/list is the help). Approvals stay
// on the Web (sensitive plans → 30 + review link). Platform down → 54 with the start command; never auto-starts.
// Added: device_snapshot (read-only screen + nodes) and doctor.
import { existsSync, readFileSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { COMMANDS, type CommandSpec, dispatch, doctorLocal } from '../scripts/cli-v1';
import { STATUS, apiError, type Code } from './lifecycle/status';

export interface Envelope {
  status: number;
  code: Code;
  exit: number;
  summary: string;
  data?: unknown;
  text?: string;
  error?: { message: string; hint?: string; retryable?: boolean; kind?: string };
}

/** CLI commands exposed as tools (§5.1). */
export const EXPOSED = ['issue list', 'issue show', 'draft create', 'draft show', 'plan explain', 'plan approve', 'plan reject', 'env list', 'env show', 'env check', 'task run', 'task status', 'task wait', 'task cancel', 'result show', 'doctor'];

const READ_ONLY = new Set(['issue list', 'issue show', 'draft show', 'plan explain', 'env list', 'env show', 'task status', 'task wait', 'result show']);
/** One MCP call waits at most this long; STILL_RUNNING (21) → the caller waits again. */
export const WAIT_MAX_S = 25;

export const toolName = (command: string) => command.replace(/ /g, '_');

/** Pure: zod input shape of a command (from its ArgSpecs; --json is implied). */
export function inputShape(c: CommandSpec): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const a of c.args) {
    if (a.name === 'json') continue;
    let t: z.ZodTypeAny = a.type === 'integer' ? z.number().int() : a.type === 'boolean' ? z.boolean() : z.string();
    t = t.describe(a.doc);
    shape[a.name] = a.required ? t : t.optional();
  }
  return shape;
}

/** Pure: tool arguments → CLI argv (positionals in order, then flags). task wait is capped at WAIT_MAX_S. */
export function argvOf(c: CommandSpec, args: Record<string, unknown>): string[] {
  const pos: string[] = [];
  const flags: string[] = [];
  const a = { ...args };
  if (c.command === 'task wait') a.timeout = Math.min(Number(a.timeout ?? WAIT_MAX_S), WAIT_MAX_S);
  for (const s of c.args) {
    const v = a[s.name];
    if (s.name === 'json' || v === undefined || v === null) continue;
    if (s.positional) pos.push(String(v));
    else if (s.type === 'boolean') {
      if (v) flags.push(`--${s.name}`);
    } else flags.push(`--${s.name}`, String(v));
  }
  return [...pos, ...flags, '--json'];
}

/** Pure: is this envelope a tool error (MCP isError)? Outcomes (10–17), accepted (20) and still running (21) are not. */
export const isToolError = (e: Pick<Envelope, 'exit'>) => e.exit === 1 || e.exit >= 30;

/** Pure: envelope → MCP tool result. structuredContent is the `--json` envelope; errors carry status / code / hint / retryable. */
export function toolResult(e: Envelope, extra: { type: 'image'; data: string; mimeType: string }[] = []) {
  const { text, ...env } = e;
  const structured = isToolError(e) ? { ...env, error: { ...apiError(e.code, e.error?.message ?? e.summary, e.error?.hint), ...e.error } } : env;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }, ...extra],
    structuredContent: structured as Record<string, unknown>,
    ...(isToolError(e) ? { isError: true } : {}),
  };
}

const envelope = (code: Code, summary: string, data?: unknown, hint?: string): Envelope => ({ status: STATUS[code].status, code, exit: STATUS[code].exit, summary, ...(data !== undefined ? { data } : {}), ...(STATUS[code].exit >= 30 ? { error: { message: summary, hint } } : {}) });

/** Run one exposed command exactly as `autotest <command> … --json` would. */
export async function runCommand(command: string, args: Record<string, unknown>): Promise<Envelope> {
  const c = COMMANDS.find((x) => x.command === command);
  if (!c || !EXPOSED.includes(command)) return envelope('BAD_INPUT', `not exposed over MCP: ${command}`);
  if (command === 'doctor') return (await doctorLocal(!!args.fix, !!args.probe)) as Envelope;
  const [obj, act] = command.split(' ');
  return (await dispatch(obj, act, argvOf(c, args))) as Envelope;
}

/** device_snapshot: current screen + normalised nodes of one phone (read-only; refused while a task holds it). */
export async function deviceSnapshot(args: { udid?: string; pkg?: string; maxNodes?: number }): Promise<{ env: Envelope; png?: Buffer }> {
  const { listDevices } = await import('./adb-devices');
  const online = (await listDevices()).filter((d) => d.state === 'device');
  const udid = args.udid ?? (online.length === 1 ? online[0].udid : undefined);
  if (!udid) return { env: envelope('BAD_INPUT', online.length ? `多台手机在线（${online.map((d) => d.udid).join(', ')}）：请指定 udid（先问用户用哪台）` : '没有在线的手机', undefined, online.length ? undefined : 'autotest doctor') };
  if (!online.some((d) => d.udid === udid)) return { env: envelope('ENV_OFFLINE', `手机 ${udid} 不在线`, undefined, 'autotest doctor') };
  // One phone, one task: a tree read now would race the running task's reads.
  const envs = (await dispatch('env', 'list', ['--json'])) as Envelope;
  const busy = Array.isArray((envs.data as any)?.envs ?? envs.data) ? (((envs.data as any)?.envs ?? envs.data) as { id: string; state: string; lease?: unknown }[]).find((e) => e.id.includes(`:${udid}@`) && (e.state === 'leased' || e.lease)) : undefined;
  if (busy) return { env: envelope('BAD_INPUT', `手机 ${udid} 正被任务占用（${busy.id}），任务结束后再取快照`, undefined, 'task status / task wait') };
  const { AndroidDriver } = await import('../drivers/android');
  const { snapshot } = await import('../executor/snapshot');
  const { selectTreeBackend } = await import('../executor/session');
  await selectTreeBackend(udid, (s) => console.error(`[mcp] ${s}`));
  const d = new AndroidDriver({ udid, packageName: args.pkg ?? '' });
  const s = await snapshot(d, { keepPng: true, pkg: args.pkg ?? '' });
  const max = Math.min(args.maxNodes ?? 300, 1000);
  const nodes = s.nodes.filter((n) => n.text || n.desc || n.clickable || n.rid).slice(0, max).map(({ id, anc, ...n }) => n);
  return { env: envelope('OK', `${udid}：${nodes.length} 个节点（${s.source}${s.fallback ? `，退回原因 ${s.fallback}` : ''}），读树 ${s.ms.tree} ms`, { udid, at: s.at, source: s.source, fallback: s.fallback, ms: s.ms, width: s.width, height: s.height, nodes, truncated: s.nodes.length > max }), png: s.png };
}

/** Read-only file roots for resources (same as the platform's /files and /refs). */
export const FILE_ROOTS = () => [resolve('midscene_run'), resolve('skills/teamily/refs')];

/** Pure-ish: a path inside one of the roots, or undefined. */
export function safeResourcePath(rel: string, roots = FILE_ROOTS()): string | undefined {
  const r = decodeURIComponent(rel).replace(/\\/g, '/');
  for (const root of roots) {
    for (const base of [root, resolve('.')]) {
      const full = normalize(resolve(base, r));
      if (full.startsWith(root + sep) && existsSync(full)) return full;
    }
  }
  return undefined;
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.md': 'text/markdown', '.json': 'application/json', '.html': 'text/html', '.txt': 'text/plain', '.ndjson': 'application/x-ndjson' };

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'autotest', version: '1.0.0' }, { instructions: 'Black-box test platform (Issue reproduction on a real phone / browser). Read docs/agent-rules.md first: doctor before guessing; plan_explain before task_run and tell the user what will be sent where; never approve sensitive plans for the user (30 = a person approves on the Web); 未复现 is not 已修复; one phone, one task; never adb kill-server.' });

  for (const command of EXPOSED) {
    const c = COMMANDS.find((x) => x.command === command)!;
    const ro = READ_ONLY.has(command);
    server.registerTool(
      toolName(command),
      {
        title: `autotest ${command}`,
        description: `${c.doc}${command === 'task wait' ? ` (one call waits ≤ ${WAIT_MAX_S} s; 21 STILL_RUNNING → call again)` : ''}. Result = the \`autotest ${command} --json\` envelope { status, code, exit, summary, data, error }. Codes: ${c.codes.join(', ')}; 54 = platform down.`,
        inputSchema: inputShape(c),
        annotations: { readOnlyHint: ro, destructiveHint: false, idempotentHint: ro, openWorldHint: command === 'draft create' || command === 'task run' },
      },
      async (args: Record<string, unknown>) => toolResult(await runCommand(command, args)),
    );
  }

  server.registerTool(
    'device_snapshot',
    {
      title: 'Current phone screen (read-only)',
      description: 'Screenshot + normalised accessibility nodes (text / desc / resource-id / class / clickable / box / centre) of one phone. Read-only: never taps. Refused while a task holds the phone. Several phones online → pass udid (ask the user which).',
      inputSchema: { udid: z.string().optional().describe('adb serial; optional when exactly one phone is online'), pkg: z.string().optional().describe('only nodes of this package (default: every window)'), maxNodes: z.number().int().optional().describe('default 300') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const r = await deviceSnapshot(args);
        return toolResult(r.env, r.png ? [{ type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' }] : []);
      } catch (e) {
        return toolResult(envelope('TOOL_FAILED', `device_snapshot: ${(e as Error).message.split('\n')[0]}`, undefined, 'autotest doctor'));
      }
    },
  );

  // Resources (§5.2): reports, views, evidence files — read-only, only inside midscene_run/ and skills/teamily/refs/.
  const textOf = (uri: URL, e: Envelope) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((({ text, ...x }) => x)(e)) }] });
  server.registerResource('task-result', new ResourceTemplate('autotest://results/{taskId}', { list: undefined }), { title: 'ResultView of a task', mimeType: 'application/json' }, async (uri, v) => textOf(uri, await runCommand('result show', { taskId: String(v.taskId) })));
  server.registerResource('plan-view', new ResourceTemplate('autotest://plans/{planId}', { list: undefined }), { title: 'PlanView (plan explain)', mimeType: 'application/json' }, async (uri, v) => textOf(uri, await runCommand('plan explain', { planId: decodeURIComponent(String(v.planId)) })));
  server.registerResource('task-report', new ResourceTemplate('autotest://reports/{taskId}', { list: undefined }), { title: 'report.md of a task', mimeType: 'text/markdown' }, async (uri, v) => {
    const { getTask } = await import('./lifecycle/task');
    const t = getTask(String(v.taskId));
    const f = t?.report ? safeResourcePath(t.report) : undefined;
    if (!f) throw new Error(`no report for task ${v.taskId}`);
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readFileSync(f, 'utf8') }] };
  });
  server.registerResource('file', new ResourceTemplate('autotest://files/{+path}', { list: undefined }), { title: 'Evidence file (screenshots, reports, incident viewer) under midscene_run/ or skills/teamily/refs/' }, async (uri, v) => {
    const f = safeResourcePath(String(v.path));
    if (!f) throw new Error('path outside midscene_run/ and skills/teamily/refs/, or missing');
    const mime = MIME[extname(f).toLowerCase()] ?? 'application/octet-stream';
    return /^(text|application\/(json|x-ndjson))/.test(mime) ? { contents: [{ uri: uri.href, mimeType: mime, text: readFileSync(f, 'utf8') }] } : { contents: [{ uri: uri.href, mimeType: mime, blob: readFileSync(f).toString('base64') }] };
  });
  return server;
}
