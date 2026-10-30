// Lightweight web console (node:http, no framework). Default port 3210 (PLATFORM_PORT).
//   GET  /                       single-page console (platform/console.html)
//   GET  /api/devices            pool devices (idle / busy / offline)
//   GET  /api/tasks              recent tasks
//   POST /api/tasks              {type, package, request?, device?, maxSteps?, maxMinutes?, seed?, events?, steps?} → 202 {id}
//   GET  /api/tasks/:id          one task
//   POST /api/tasks/:id/cancel   kill a running / drop a queued task
//   GET  /api/tasks/:id/report   markdown report (text/markdown)
//   GET  /api/tasks/:id/log      live log (text/plain)
//   GET  /files/<path>           read-only artifacts under midscene_run/ (screenshots, HTML replays, issue runs)
//   GET  /api/issues             issues/*.md with their pre-classification (rules)
//   POST /api/issues             {name, content} upload an Issue markdown → issues/<name>.md
//   GET  /api/issues/:id/draft   draft for the one-time confirmation (category, sub-cases, substitution boxes)
//   /api/v1/*                    W2-3 service for the CLI (agents) and the Web pages (people): see platform/api-v1.ts
//   GET  /web/<page>.html        W2-3 pages (home, environment, plan review, result)
// Tasks run asynchronously in child processes; the browser polls.
import 'dotenv/config';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';
import { readdir, writeFile } from 'node:fs/promises';
import { classifyRules } from '../issue/classify';
import { parseIssue } from '../issue/parse';
import { DevicePool } from './device-pool';
import { TaskManager, validateTaskInput } from './tasks';
import { AccountPool } from './accounts/account-pool';
import { apiV1, refFile } from './api-v1';
import { Supervisor } from './lifecycle/supervisor';

const PORT = Number(process.env.PLATFORM_PORT ?? 3210);
const FILES_ROOT = resolve('midscene_run');
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

const pool = new DevicePool();
const tasks = new TaskManager(pool);
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
  const m = p.match(/^\/api\/tasks\/([\w-]+)(?:\/(report|log|cancel))?$/);

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
  if (req.method === 'GET' && (p === '/console' || p === '/console.html')) return send(res, 200, await readFile(resolve('platform/console.html')), 'text/html; charset=utf-8');
  if (req.method === 'GET' && p === '/api/devices') return send(res, 200, { config: pool.config, devices: await pool.refresh() });
  if (req.method === 'GET' && p === '/api/issues') {
    const files = (await readdir(resolve('issues'))).filter((f) => f.endsWith('.md'));
    const list = [];
    for (const f of files) {
      const i = parseIssue(f.slice(0, -3), await readFile(resolve('issues', f), 'utf8'));
      const c = classifyRules(i);
      list.push({ id: i.id, title: i.title, frequency: i.frequency, platforms: i.platforms, category: c.category, reason: c.reason });
    }
    return send(res, 200, list);
  }
  if (req.method === 'POST' && p === '/api/issues') {
    const b = (await readBody(req).catch(() => null)) as { name?: string; content?: string } | null;
    const name = String(b?.name ?? '').replace(/\.md$/, '');
    if (!/^[\w-]{1,40}$/.test(name) || !b?.content) return send(res, 400, { error: 'name ([\w-]) and content required' });
    await writeFile(resolve('issues', `${name}.md`), String(b.content).slice(0, 200_000));
    return send(res, 201, { id: name });
  }
  const di = p.match(/^\/api\/issues\/([\w-]+)\/draft$/);
  if (req.method === 'GET' && di) {
    const { loadDraft } = await import('../scripts/issue-cli');
    // "生成计划" drafts anew (redraft=0 reuses the saved draft); the task then runs exactly this draft (hash).
    const d = await loadDraft(di[1], (url.searchParams.get('env') as 'test' | 'prod') ?? 'prod', url.searchParams.get('model') !== '0', url.searchParams.get('redraft') !== '0');
    return send(res, 200, {
      id: d.issue.id,
      hash: d.hash,
      title: d.issue.title,
      status: d.status,
      category: d.classification.category,
      reason: d.reason,
      deferredPart: d.deferredPart,
      subcases: d.subcases.map((s) => ({ sub: s.sub, title: s.title, planTitle: s.plan.title, surface: s.surface, substitution: s.substitution, planErrors: s.planErrors, generatedBy: s.plan.provenance.generatedBy, pattern: s.plan.provenance.pattern, coverage: s.plan.coverage, contract: s.contract })),
    });
  }
  if (req.method === 'GET' && p === '/api/tasks') return send(res, 200, tasks.tasks.slice(0, 50));
  if (req.method === 'POST' && p === '/api/tasks') {
    const input = validateTaskInput(await readBody(req).catch(() => null));
    if (typeof input === 'string') return send(res, 400, { error: input });
    const t = await tasks.create(input);
    return send(res, 202, { id: t.id, status: t.status });
  }
  if (m) {
    const t = tasks.get(m[1]);
    if (!t) return send(res, 404, { error: 'no such task' });
    if (req.method === 'POST' && m[2] === 'cancel') return send(res, (await tasks.cancel(t.id)) ? 200 : 409, { id: t.id });
    if (req.method === 'GET' && !m[2]) return send(res, 200, t);
    if (req.method === 'GET' && m[2] === 'log') return send(res, 200, existsSync(t.logFile) ? await readFile(t.logFile, 'utf8') : '', 'text/plain; charset=utf-8');
    if (req.method === 'GET' && m[2] === 'report') {
      if (!t.reportFile || !existsSync(t.reportFile)) return send(res, 404, { error: `report not ready (status ${t.status})` });
      return send(res, 200, await readFile(t.reportFile, 'utf8'), 'text/markdown; charset=utf-8');
    }
  }
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
  await tasks.load();
  tasks.start();
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
