// pnpm autotest runs prune [--apply] [--days 14] [--keep 3] [--list]
// Retention for midscene_run/ (platform/runs-prune.ts). Without --apply it only reports what would go.
import { relative } from 'node:path';
import { pruneRuns } from '../platform/runs-prune';

const args = process.argv.slice(2);
if (args[0] !== 'prune') {
  console.error('Usage: pnpm autotest runs prune [--apply] [--days 14] [--keep 3] [--list]');
  process.exit(2);
}
const num = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const apply = args.includes('--apply');
const r = pruneRuns({ apply, days: num('--days'), keepPerKey: num('--keep') });
const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;
const tally = (xs: { reason: string; bytes: number }[]) => {
  const t: Record<string, number> = {};
  for (const x of xs) t[x.reason] = (t[x.reason] ?? 0) + 1;
  return t;
};
if (args.includes('--list')) for (const d of r.delete) console.log(`${(d.bytes / 1e6).toFixed(1).padStart(8)} MB  ${relative(process.cwd(), d.path)}`);
console.log(`${apply ? 'deleted' : 'would delete'}: ${r.delete.length} entries, ${gb(r.freedBytes)}`);
console.log('kept (top-level run folders):', tally(r.keep));
if (r.failed.length) console.log(`failed (in use?): ${r.failed.length}`, r.failed.slice(0, 5));
