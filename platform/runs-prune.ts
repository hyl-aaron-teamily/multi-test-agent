// Retention for midscene_run/ (user 2026-11-13: it had grown to 8.9 GB with no policy). Run directories are
// removed when they are older than `days` AND none of these holds:
//   - the run is a conclusion worth keeping: an Issue reproduced (`conclusion` 已复现), or an exploration with
//     findings (the W3-4 / W3-5 triage and replay data);
//   - it is one of the newest `keepPerKey` runs of the same Issue / plan / surface;
//   - its directory name is referenced from docs/, fixtures/, issues/ or platform/plans/ (acceptance records,
//     evidence cases, drafts).
// bench/, w3m2-baseline/ and cache/ are kept whole; evidence-cases/ and web-shots/ keep their newest `keepPerKey`
// runs. Anything else at the top (W1-era folders, midscene reports and logs, loose files) goes by age only.
// Default is a dry run; `apply` deletes. The platform runs it on start (platform/server.ts).
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface PruneOptions {
  root?: string;
  /** Keep everything younger than this. Default 14. */
  days?: number;
  /** Keep the newest N runs per Issue / plan / surface. Default 3. */
  keepPerKey?: number;
  /** Text that may reference run directories (default: docs/, fixtures/, issues/, platform/plans/). */
  refText?: string;
  apply?: boolean;
  now?: number;
}

export interface PruneItem {
  path: string;
  bytes: number;
  reason: string;
}

export interface PruneReport {
  delete: PruneItem[];
  keep: PruneItem[];
  freedBytes: number;
  failed: string[];
}

const RUN_DIRS = ['issues', 'series', 'sync', 'explore'];
const KEEP_WHOLE = ['bench', 'w3m2-baseline', 'cache'];
const NEWEST_ONLY = ['evidence-cases', 'web-shots'];

const sizeOf = (p: string): number => {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    return readdirSync(p).reduce((n, c) => n + sizeOf(join(p, c)), 0);
  } catch {
    return 0;
  }
};

/** Pure: the Issue / plan / surface a run directory belongs to (its name without timestamps and task ids). */
export const runKey = (name: string): string =>
  name
    .replace(/-?20\d\d-\d\d-\d\dT[\d-]+Z/g, '')
    .replace(/-?t-\d{14}-[a-z0-9]{4}/g, '')
    .replace(/-+$/, '') || '(none)';

/** Pure: a parsed result says the Issue was reproduced, or an exploration had findings. */
export function isConclusion(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = isConclusion(x);
      if (r) return r;
    }
    return undefined;
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.conclusion === 'string' && o.conclusion.startsWith('已复现')) return 'reproduced';
  if (o.status === 'reproduced' || o.reproduced === true) return 'reproduced';
  if (Array.isArray(o.findings) && o.findings.some((f) => f && typeof f === 'object' && (f as { counted?: boolean }).counted !== false)) return 'findings';
  for (const x of Object.values(o)) {
    const r = isConclusion(x);
    if (r) return r;
  }
  return undefined;
}

function conclusionOf(dir: string, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && /^(result|series)\.json$/.test(e.name)) {
      try {
        const r = isConclusion(JSON.parse(readFileSync(p, 'utf8')));
        if (r) return r;
      } catch {
        /* unreadable result: no conclusion */
      }
    } else if (e.isDirectory() && !['steps', 'incidents', 'video', 'screens'].includes(e.name)) {
      const r = conclusionOf(p, depth + 1);
      if (r) return r;
    }
  }
  return undefined;
}

function textUnder(dir: string, depth = 0): string {
  if (depth > 6 || !existsSync(dir)) return '';
  let s = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'steps', 'video', 'archive-2026-11-13-before-explore-first'].includes(e.name)) s += textUnder(p, depth + 1);
    } else if (/\.(md|ya?ml|json|txt)$/.test(e.name) && statSync(p).size < 5e6) s += readFileSync(p, 'utf8');
  }
  return s;
}

export const defaultRefText = (): string => ['docs', 'fixtures', 'issues', 'platform/plans'].map((d) => textUnder(resolve(d))).join('\n');

const mtimeOf = (p: string) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

export function pruneRuns(o: PruneOptions = {}): PruneReport {
  const root = resolve(o.root ?? 'midscene_run');
  const now = o.now ?? Date.now();
  const cutoff = now - (o.days ?? 14) * 86_400_000;
  const keepN = o.keepPerKey ?? 3;
  const refs = o.refText ?? defaultRefText();
  const rep: PruneReport = { delete: [], keep: [], freedBytes: 0, failed: [] };
  if (!existsSync(root)) return rep;
  const decide = (path: string, keep: string | undefined, why: string) => (keep ? rep.keep : rep.delete).push({ path, bytes: 0, reason: keep ?? why });

  for (const top of readdirSync(root)) {
    const tp = join(root, top);
    const isDir = statSync(tp).isDirectory();
    if (KEEP_WHOLE.includes(top)) continue;
    if (!isDir) {
      decide(tp, mtimeOf(tp) >= cutoff ? 'recent' : undefined, 'old file');
      continue;
    }
    const children = readdirSync(tp)
      .map((n) => ({ n, p: join(tp, n), t: mtimeOf(join(tp, n)) }))
      .sort((a, b) => b.t - a.t);
    if (RUN_DIRS.includes(top)) {
      const seen = new Map<string, number>();
      for (const c of children) {
        const k = runKey(c.n);
        const rank = (seen.get(k) ?? 0) + 1;
        seen.set(k, rank);
        const keep = c.t >= cutoff ? 'recent' : rank <= keepN ? `newest ${keepN} of ${k}` : refs.includes(c.n) ? 'referenced' : conclusionOf(c.p);
        decide(c.p, keep, 'old run, no conclusion, not referenced');
      }
    } else if (NEWEST_ONLY.includes(top)) {
      children.forEach((c, i) => decide(c.p, i < keepN ? `newest ${keepN}` : c.t >= cutoff ? 'recent' : undefined, 'old run'));
    } else {
      for (const c of children) decide(c.p, c.t >= cutoff ? 'recent' : refs.includes(c.n) ? 'referenced' : undefined, 'old');
    }
  }
  for (const d of rep.delete) {
    d.bytes = sizeOf(d.path);
    rep.freedBytes += d.bytes;
  }
  if (o.apply) {
    for (const d of rep.delete) {
      try {
        rmSync(d.path, { recursive: true, force: true });
      } catch {
        rep.failed.push(d.path);
      }
    }
    // Top-level folders emptied by this pass go too (the run folders themselves stay).
    for (const top of readdirSync(root)) {
      const tp = join(root, top);
      if (![...RUN_DIRS, ...KEEP_WHOLE].includes(top) && statSync(tp).isDirectory() && readdirSync(tp).length === 0) rmSync(tp, { recursive: true, force: true });
    }
  }
  return rep;
}
