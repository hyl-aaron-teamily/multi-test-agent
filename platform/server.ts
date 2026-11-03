// Lightweight web console (node:http, no framework). Default port 3210 (PLATFORM_PORT).
//   GET  /  /style.css  /app.js        the single-page Web console (platform/web, hash routes, W2-4.1 §7)
//   GET  /api/v1/tasks/<id>/stream     server-sent events: the TaskView (+ steps) whenever it changes
//   /api/v1/*                          service for the CLI (agents) and the Web (people): platform/api-v1.ts
//   GET  /api/devices                  pool devices (idle / busy / offline)
//   GET  /files/<path>                 read-only artifacts under midscene_run/ (screenshots, bundles, reports)
//   GET  /<old page>.html?id=…         redirect to the hash route (links in older reports and hints)
// Tasks run asynchronously in child processes (platform/lifecycle).
import 'dotenv/config';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { stateRoot } from './lifecycle/store';
import { DevicePool } from './device-pool';
import { AccountPool } from './accounts/account-pool';
import { apiV1 } from './api-v1';
import { Supervisor } from './lifecycle/supervisor';

const PORT = Number(process.env.PLATFORM_PORT ?? 3210);
const FILES_ROOT = resolve('midscene_run');
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

const pool = new DevicePool();
const accounts = new AccountPool();
let sup: Supervisor | undefined;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64_000) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}

/** Resolve /files/<p> inside FILES_ROOT only. Pure, exported for tests. */
export function safeFilePath(root: string, urlPath: string): string | undefined {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = normalize(resolve(root, rel));
  return full === root || full.startsWith(root + sep) ? full : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;

  const stream = req.method === 'GET' && p.match(/^\/api\/v1\/tasks\/([^/]+)\/stream$/);
  if (stream) return taskStream(decodeURIComponent(stream[1]), req, res);
  if (p.startsWith('/api/v1/')) {
    const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
    const env = await apiV1({ method: req.method ?? 'GET', path: p, query: url.searchParams, body, web: req.headers['x-autotest-client'] === 'web' }, { sup });
    return send(res, env.status, env);
  }
  const asset = STATIC[p];
  if (req.method === 'GET' && asset) return send(res, 200, await readFile(resolve('platform/web', asset[0])), asset[1]);
  const old = req.method === 'GET' && p.match(/^\/(env|plan|result|task)\.html$/);
  if (old) {
    const id = url.searchParams.get('id');
    res.writeHead(302, { location: `/#/${old[1]}${id ? `/${encodeURIComponent(id)}` : ''}${url.searchParams.get('series') ? `?series=${url.searchParams.get('series')}` : ''}` });
    return void res.end();
  }
  if (req.method === 'GET' && p === '/api/devices') return send(res, 200, { config: pool.config, devices: await pool.refresh() });
  if (req.method === 'GET' && p.startsWith('/files/')) {
    const f = safeFilePath(FILES_ROOT, p.slice('/files/'.length));
    if (!f || !existsSync(f) || !statSync(f).isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    createReadStream(f).pipe(res);
    return;
  }
  send(res, 404, { error: 'not found' });
}

const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

/** SSE: the task (and its steps) once a second while it changes; ends after the terminal state. */
function taskStream(id: string, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  let last = '';
  let beat = Date.now();
  const q = (path: string) => apiV1({ method: 'GET', path: `/api/v1/tasks/${encodeURIComponent(id)}${path}`, query: new URLSearchParams(), body: {}, web: true }, { sup });
  const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const tick = async () => {
    const t = await q('');
    if (t.code === 'NOT_FOUND') {
      sse('gone', { summary: t.summary });
      return stop();
    }
    const steps = await q('/steps');
    const body = JSON.stringify({ task: t.data, steps: steps.data });
    if (body !== last) {
      last = body;
      beat = Date.now();
      sse('task', { task: t.data, steps: steps.data });
    } else if (Date.now() - beat > 15_000) {
      beat = Date.now();
      res.write(': keep-alive\n\n');
    }
    if ((t.data as { finishedAt?: string } | undefined)?.finishedAt) stop();
  };
  const timer = setInterval(() => void tick().catch(() => stop()), 1000);
  const stop = () => {
    clearInterval(timer);
    res.end();
  };
  req.on('close', () => clearInterval(timer));
  void tick().catch(() => stop());
}

async function main() {
  await pool.reloadConfig();
  await accounts.reload();
  await pool.refresh();
  sup = new Supervisor(pool, accounts);
  await sup.start();
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[platform] ${sig}: scheduling stopped — running task processes keep their leases and are adopted on the next start`);
    await sup?.shutdown().catch((e) => console.error(e));
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: (err as Error).message }));
  }).listen(PORT, () => {
    // Who serves this port (W2-5 §9 acceptance: stop exactly this process, not the task processes it started).
    writeFileSync(join(stateRoot(), 'platform.pid'), String(process.pid));
    console.log(`[platform] console → http://localhost:${PORT}  (maxConcurrent=${pool.config.maxConcurrent}, devices=${pool.config.devices.map((d) => d.udid).join(', ') || 'all adb'})`);
  });
}

if (process.argv[1] && resolve(process.argv[1]).endsWith(`platform${sep}server.ts`)) void main();
