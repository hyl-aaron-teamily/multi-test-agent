// One platform session = from start to stop (user 2026-11-13: the project is a demo; every start is a new
// platform, nothing from a run is kept unless someone pressed 「另存为」).
//   endSession()  : stop the task processes still running, then delete every run artifact: all of midscene_run/
//                   and the runtime records under platform/state/. Called by `pnpm stop` (scripts/ctl.ts) and at
//                   platform start (platform/server.ts), so a crash or a reboot also starts fresh.
//   saveRun()     : 「另存为」 — copy a task (its record, result and run directory) or any folder under
//                   midscene_run/ to saved/<name>/, which no session end touches.
// Kept across sessions: configuration and learned knowledge, not runs — accounts.json (disabled / login-failed
// marks), full-access.json, audit.ndjson (rule G2: switching full access is audited), skill-cache/,
// devices-parallel.yaml; and everything in git (drafts, SKILL, fixtures) plus issues/ and docs/.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { alive, killTree } from './lifecycle/proc';
import { stateRoot } from './lifecycle/store';
import { isTerminal, listTasks, taskDir, type TaskRecord } from './lifecycle/task';

export const runsRoot = () => resolve(process.env.AUTOTEST_RUNS_DIR ?? 'midscene_run');
export const savedRoot = () => resolve(process.env.AUTOTEST_SAVED_DIR ?? 'saved');

/** What survives a session end under platform/state/. Everything else there is a run record. */
export const KEEP_STATE = ['accounts.json', 'full-access.json', 'audit.ndjson', 'skill-cache', 'devices-parallel.yaml'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kill the task processes that are still alive (pid + start time checked); wait up to `waitMs` for them to go. */
export async function stopTaskProcesses(o: { waitMs?: number; isAlive?: typeof alive; kill?: (pid: number) => void } = {}): Promise<string[]> {
  const isAlive = o.isAlive ?? alive;
  const kill = o.kill ?? killTree;
  const live = listTasks().filter((t) => !isTerminal(t.state) && t.proc && isAlive(t.proc));
  for (const t of live) kill(t.proc!.pid);
  const deadline = Date.now() + (o.waitMs ?? 15_000);
  while (live.some((t) => isAlive(t.proc)) && Date.now() < deadline) await sleep(300);
  return live.map((t) => t.id);
}

export interface WipeResult {
  removed: number;
  failed: string[];
}

/** Delete all run artifacts: every entry of midscene_run/ and the runtime records under platform/state/.
 *  `keep` adds names under platform/state/ to leave (the platform's own open log at start). */
export function wipeSession(o: { keep?: string[] } = {}): WipeResult {
  const res: WipeResult = { removed: 0, failed: [] };
  const rm = (p: string) => {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      res.removed++;
    } catch {
      res.failed.push(p);
    }
  };
  const runs = runsRoot();
  if (existsSync(runs)) for (const n of readdirSync(runs)) rm(join(runs, n));
  const state = stateRoot();
  const keep = new Set([...KEEP_STATE, ...(o.keep ?? [])]);
  if (existsSync(state)) for (const n of readdirSync(state)) if (!keep.has(n)) rm(join(state, n));
  return res;
}

/** `pnpm stop` and platform start: stop leftover task processes, then wipe. */
export async function endSession(o: { keep?: string[] } = {}): Promise<WipeResult & { stopped: string[] }> {
  const stopped = await stopTaskProcesses();
  return { ...wipeSession(o), stopped };
}

/** Where a saved item goes back to when the archive is opened: platform/state/<rel> or midscene_run/<rel>. */
export interface SavedPlace {
  /** Path inside the saved folder. */
  saved: string;
  root: 'state' | 'runs';
  rel: string;
}

export interface SavedMeta {
  name: string;
  savedAt: string;
  /** Task id, or the folder under midscene_run/ that was saved. */
  source: string;
  taskId?: string;
  summary?: string;
  /** Saved paths, relative to the saved folder. */
  items: string[];
  places: SavedPlace[];
}

/** Recursive copy. Not fs.cpSync: on Windows (Node 22) it copies nothing, silently, when the destination path
 *  has non-ASCII characters — and saved names are usually Chinese. */
export function copyTree(src: string, dest: string): void {
  if (statSync(src).isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const n of readdirSync(src)) copyTree(join(src, n), join(dest, n));
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

const safeName = (s: string) => s.replace(/[^\w.@一-鿿-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'run';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slash = (p: string) => p.replace(/\\/g, '/');

function freeDir(name: string): string {
  const root = savedRoot();
  let dir = join(root, name);
  for (let i = 2; existsSync(dir); i++) dir = join(root, `${name}-${i}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Pure: is `p` inside the run folder (and not the folder itself)? */
export const insideRuns = (p: string, runs = runsRoot()) => {
  const r = resolve(p);
  return r.startsWith(runs + sep) && r !== runs;
};

function writeMeta(dir: string, m: Omit<SavedMeta, 'name' | 'savedAt' | 'items'>): SavedMeta & { dir: string } {
  const meta: SavedMeta = { name: basename(dir), savedAt: new Date().toISOString(), ...m, items: m.places.map((p) => p.saved) };
  writeFileSync(join(dir, 'saved.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { ...meta, dir };
}

/** 「另存为」 a task: its record folder, plus its run directory and report when they are under midscene_run/. */
export function saveTask(t: TaskRecord, name?: string): SavedMeta & { dir: string } {
  const dir = freeDir(safeName(name || `${t.id}-${t.kind}`));
  const places: SavedPlace[] = [];
  const copy = (src: string, saved: string, root: SavedPlace['root'], rel: string) => {
    if (!existsSync(src)) return;
    copyTree(src, join(dir, saved));
    places.push({ saved: slash(saved), root, rel: slash(rel) });
  };
  copy(taskDir(t.id), 'task', 'state', join('tasks', t.id));
  if (t.runDir && insideRuns(t.runDir)) copy(t.runDir, join('run', basename(t.runDir)), 'runs', relative(runsRoot(), t.runDir));
  if (t.report && insideRuns(t.report) && !(t.runDir && resolve(t.report).startsWith(resolve(t.runDir) + sep))) copy(t.report, join('report', basename(t.report)), 'runs', relative(runsRoot(), t.report));
  return writeMeta(dir, { source: t.id, taskId: t.id, summary: t.outcome?.summary, places });
}

/** 「另存为」 any folder or file under midscene_run/ (bench reports, CLI runs). */
export function savePath(p: string, name?: string): SavedMeta & { dir: string } {
  const src = resolve(p);
  if (!insideRuns(src) || !existsSync(src)) throw new Error(`${p} 不在 midscene_run/ 里，或不存在`);
  const rel = relative(runsRoot(), src);
  const dir = freeDir(safeName(name || `${rel.replace(/[\\/]/g, '-')}-${stamp()}`));
  copyTree(src, join(dir, basename(src)));
  return writeMeta(dir, { source: `midscene_run/${slash(rel)}`, places: [{ saved: basename(src), root: 'runs', rel: slash(rel) }] });
}

/** The folder of one saved run, by name (no path tricks: a direct child of saved/). Offline tools read it here. */
export function savedDir(name: string): string {
  const root = savedRoot();
  const dir = resolve(root, name);
  if (dirname(dir) !== root || !existsSync(join(dir, 'saved.json'))) throw new Error(`没有存档「${name}」`);
  return dir;
}

export function readSaved(name: string): SavedMeta & { dir: string } {
  const dir = savedDir(name);
  return { ...(JSON.parse(readFileSync(join(dir, 'saved.json'), 'utf8')) as SavedMeta), dir };
}

export function listSaved(): (SavedMeta & { dir: string })[] {
  const root = savedRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => existsSync(join(root, n, 'saved.json')))
    .map((n) => readSaved(n))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** 「打开存档」: copy a saved run back where it was, so the task, result and report pages work as they did.
 *  The copy belongs to this session (deleted at stop); the archive itself is untouched. Opening twice is a no-op. */
export function openSaved(name: string): { taskId?: string; opened: string[]; already: boolean } {
  const s = readSaved(name);
  const opened: string[] = [];
  let already = true;
  for (const p of s.places) {
    const base = p.root === 'state' ? stateRoot() : runsRoot();
    const dest = resolve(base, p.rel);
    if (!dest.startsWith(base + sep)) throw new Error(`存档「${name}」的位置不合法：${p.rel}`);
    opened.push(dest);
    if (existsSync(dest)) continue;
    already = false;
    copyTree(join(s.dir, p.saved), dest);
  }
  if (s.taskId && !already) {
    const f = join(taskDir(s.taskId), 'task.json');
    if (existsSync(f)) writeFileSync(f, `${JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), restoredFrom: s.name }, null, 2)}\n`);
  }
  return { taskId: s.taskId, opened, already };
}

/** Delete a saved run for good. */
export function deleteSaved(name: string): void {
  rmSync(savedDir(name), { recursive: true, force: true });
}
