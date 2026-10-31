// Lightweight web console (node:http, no framework). Default port 3210 (PLATFORM_PORT).
//   GET  /                       Web pages (platform/web)
//   GET  /api/devices            pool devices (idle / busy / offline)
//   GET  /files/<path>           read-only artifacts under midscene_run/ (screenshots, HTML replays, issue runs)
//   /api/v1/*                    W2-3 service for the CLI (agents) and the Web pages (people): see platform/api-v1.ts
//   GET  /web/<page>.html        W2-3 pages (home, environment, plan review, result)
// Tasks run asynchronously in child processes (platform/lifecycle); the browser polls.
import 'dotenv/config';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';
import { DevicePool } from './device-pool';
import { AccountPool } from './accounts/account-pool';
import { apiV1, refFile } from './api-v1';
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

  if (p.startsWith('/api/v1/')) {
    const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
    const env = await apiV1({ method: req.method ?? 'GET', path: p, query: url.searchParams, body, web: req.headers['x-autotest-client'] === 'web' }, { sup });
    return send(res, env.status, env);
  }
  if (req.method === 'GET' && p.startsWith('/refs/')) {
    const f = refFile(p.slice('/refs/'.length));
    if (!f) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    createReadStream(f).pipe(res);
    return;
  }
  const page = p === '/' ? 'index.html' : p.match(/^\/(index|env|plan|result|task)\.html$/)?.[0].slice(1);
  if (req.method === 'GET' && page) return send(res, 200, await readFile(resolve('platform/web', page)), 'text/html; charset=utf-8');
  if (req.method === 'GET' && p === '/web.js') return send(res, 200, await readFile(resolve('platform/web/web.js')), 'text/javascript; charset=utf-8');
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
    console.log(`[platform] ${sig}: draining environments (tasks stop at a step boundary, ≤ 60 s) …`);
    await sup?.shutdown().catch((e) => console.error(e));
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: (err as Error).message }));
  }).listen(PORT, () => {
    console.log(`[platform] console → http://localhost:${PORT}  (maxConcurrent=${pool.config.maxConcurrent}, devices=${pool.config.devices.map((d) => d.udid).join(', ') || 'all adb'})`);
  });
}

if (process.argv[1] && resolve(process.argv[1]).endsWith(`platform${sep}server.ts`)) void main();
