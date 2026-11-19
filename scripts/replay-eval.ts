// W3-5 §8.8 offline replay: the findings of past explorations judged again with and without the lessons, against
// people's labels — no device, no model, repeatable.
//   pnpm autotest memory replay                                   (through the platform: data set + this session)
//   npx tsx scripts/replay-eval.ts [--saved <name>]… [--dir <run dir>]… [--export] [--json]
// --saved / --dir add runs (a 「另存为」 archive, or a run dir with result.json); --export writes them into the data
// set fixtures/replay/<run>.local.json (texts and labels only; not in git).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readTriage } from '../engine/explore/known';
import { readLessons } from '../platform/memory/lessons';
import { exportRun, readDataset, replay, reportText, type ReplayRun, runOf } from '../platform/memory/replay';
import { savedDir } from '../platform/session';

const args = process.argv.slice(2);
const many = (n: string) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : []));

/** Every result.json with an exploration result under a folder (an archive holds the run dir and the task record). */
function resultsUnder(dir: string, depth = 4): { run: string; r: any }[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: { run: string; r: any }[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'result.json') {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const r = j.kind === 'agent' ? j : j.agent;
        if (r?.kind === 'agent') out.push({ run: basename(dir), r });
      } catch {
        /* not a result */
      }
    } else if (statSync(p).isDirectory() && !['steps', 'incidents', 'notes', 'flight'].includes(e)) out.push(...resultsUnder(p, depth - 1));
  }
  return out;
}

const triage = readTriage();
const extra: ReplayRun[] = [];
for (const name of many('saved')) for (const x of resultsUnder(savedDir(name))) extra.push(runOf(x.run, x.r, triage));
for (const d of many('dir')) for (const x of resultsUnder(d)) extra.push(runOf(x.run, x.r, triage));
if (args.includes('--export')) for (const r of extra) console.log(`exported ${exportRun(r)}`);
const runs = [...readDataset().filter((r) => !extra.some((x) => x.run === r.run)), ...extra];
const rep = replay(runs, readLessons().filter((l) => l.status === 'active'));
if (args.includes('--json')) console.log(JSON.stringify({ runs: runs.length, ...rep }, null, 2));
else console.log(`回放 ${runs.length} 次运行、${rep.rows.length} 个发现\n${reportText(rep)}`);
