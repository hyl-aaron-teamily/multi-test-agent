// W3-1 §9 R4: redesign every local Issue (issues/ and fixtures/issues) with the model and write one table —
// per Issue: draft status, plan version, sub-cases, validator result, missing blocks, model calls, and the
// latest run of each plan version (executability + reproduction rate) when there is one.
//   npx tsx scripts/regress-w3.ts [--draft] [--only 2063,2485] [--out docs/w3m1-regression.md] [--parallel 3]
// Without --draft it only tabulates the saved drafts and runs (no model call).
import 'dotenv/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RunResult } from '../engine/plan/run';
import { DRAFTS_DIR } from '../issue/drafts';
import type { Draft } from '../issue/planner';
import { listTasks, readResult } from '../platform/lifecycle/task';
import { loadDraft } from './issue-cli';

const flag = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);

/** Issue files: issues/*.md first, then the committed samples not shadowed by a local copy. */
export function issueFiles(): { id: string; file: string }[] {
  const out = new Map<string, string>();
  for (const dir of ['issues', 'fixtures/issues'])
    if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) if (!out.has(f.slice(0, -3))) out.set(f.slice(0, -3), resolve(dir, f));
  return [...out].map(([id, file]) => ({ id, file })).sort((a, b) => a.id.localeCompare(b.id));
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** Latest finished run of each plan id of an Issue (task results). */
function runsOf(issue: string): RunResult[] {
  const out = new Map<string, RunResult>();
  for (const t of listTasks().filter((x) => x.issue === issue && !x.parent).reverse()) {
    const r = readResult<{ runs?: RunResult[]; invalidated?: unknown }>(t.id);
    if (!r?.runs || r.invalidated) continue;
    for (const x of r.runs) out.set(x.planId, x);
  }
  return [...out.values()];
}

/** Design seconds per Issue from a regress log ("[regress] <id>: … (<n>s, <k> calls)"), for drafts made before designMs existed. */
export function logTimes(log: string): Map<string, { sec: number; calls: number }> {
  return new Map([...log.matchAll(/^\[regress\] (\S+): .*\((\d+)s, (\d+) calls\)$/gm)].map((m) => [m[1], { sec: Number(m[2]), calls: Number(m[3]) }]));
}

export function row(id: string, d: Draft | undefined, runs: RunResult[], err?: string, t?: { sec: number; calls: number }): string {
  if (!d) return `| ${id} | ${err ? `❌ ${err.slice(0, 120)}` : '无草稿'} | | | | | | |`;
  const sec = d.designMs !== undefined ? Math.round(d.designMs / 1000) : t?.sec;
  const time = sec === undefined ? '-' : `${sec}s / ${d.modelCalls ?? t?.calls ?? '?'} 次`;
  const status = d.stale ? '待重写' : d.status === 'plannable' ? '✅ 可执行' : d.status === 'needs-block' ? '🧱 缺积木' : '❌ 无法生成计划';
  const missing = d.envelope?.feasibility.missing.map((m) => `${m.kind}「${m.need}」`).join('；') || '-';
  const errs = d.errors?.length ? d.errors.slice(0, 2).join('；').slice(0, 160) : d.status !== 'plannable' ? d.reason.slice(0, 160) : '-';
  const run = runs.filter((r) => r.planVersion).map((r) => `${r.planId}: ${r.conclusion}${r.attempts?.valid ? ` ${r.attempts.hits}/${r.attempts.valid}` : ''}${r.executability ? `，偏离 ${pct(r.executability.driftRate)}` : ''}`).join('<br>') || '未运行';
  const hist = (d.history ?? []).map((h) => `v${h.version} ${h.conclusion} ${h.hits}/${h.valid}`).join('；');
  return `| ${id} | ${status} | ${time} | ${d.planVersion ? `v${d.planVersion}` : '-'}${hist ? `（${hist}）` : ''} | ${d.subcases.map((s) => s.sub).join(', ') || '-'} | ${missing} | ${errs.replace(/\|/g, '/')} | ${run} |`;
}

async function main() {
  const only = flag('only')?.split(',');
  const files = issueFiles().filter((f) => !only || only.includes(f.id));
  const out = flag('out') ?? 'docs/w3m1-regression.md';
  const parallel = Number(flag('parallel') ?? 3);
  const results = new Map<string, { d?: Draft; err?: string }>();
  if (process.argv.includes('--draft')) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.max(1, parallel) }, async () => {
        while (next < files.length) {
          const f = files[next++];
          const t0 = Date.now();
          try {
            const d = await loadDraft(f.file, 'prod', true, true);
            results.set(f.id, { d });
            console.log(`[regress] ${f.id}: ${d.status}${d.planVersion ? ` v${d.planVersion}` : ''} ${d.subcases.map((s) => s.sub).join(',')} (${Math.round((Date.now() - t0) / 1000)}s, ${d.modelCalls ?? 0} calls)`);
          } catch (e) {
            results.set(f.id, { err: (e as Error).message.split('\n')[0] });
            console.log(`[regress] ${f.id}: ERROR ${(e as Error).message.split('\n')[0]}`);
          }
        }
      }),
    );
  }
  const lines = ['# W3-1 回归：本地全部 Issue 重新设计用例', '', `生成于 ${new Date().toISOString()}；Issue ${files.length} 份（issues/ 与 fixtures/issues）。`, '', '| Issue | 草稿 | 设计用时 / 模型调用 | 计划版本（历史） | 子用例 | 缺的积木 | 校验 / 原因 | 运行（可执行性 · 复现率） |', '|---|---|---|---|---|---|---|---|'];
  const times = flag('log') && existsSync(flag('log')!) ? logTimes(readFileSync(flag('log')!, 'utf8')) : new Map();
  for (const f of files) {
    const r = results.get(f.id);
    const saved = existsSync(join(DRAFTS_DIR, `${f.id}.json`)) ? (JSON.parse(readFileSync(join(DRAFTS_DIR, `${f.id}.json`), 'utf8')) as Draft) : undefined;
    lines.push(row(f.id, r?.d ?? saved, runsOf(f.id), r?.err, times.get(f.id)));
  }
  const ds = files.map((f) => results.get(f.id)?.d ?? (existsSync(join(DRAFTS_DIR, `${f.id}.json`)) ? (JSON.parse(readFileSync(join(DRAFTS_DIR, `${f.id}.json`), 'utf8')) as Draft) : undefined));
  const n = (s: string) => ds.filter((d) => d?.status === s && !d.stale).length;
  const secs = files.map((f) => results.get(f.id)?.d?.designMs ?? (times.get(f.id)?.sec ?? 0) * 1000).filter((x) => x > 0).map((x) => x / 1000);
  if (secs.length) lines.push('', `设计用时（调用模型的 ${secs.length} 份）：合计 ${Math.round(secs.reduce((a, b) => a + b, 0))}s，中位 ${Math.round([...secs].sort((a, b) => a - b)[Math.floor(secs.length / 2)])}s，最长 ${Math.round(Math.max(...secs))}s。`);
  lines.push('', `合计：可执行 ${n('plannable')}，缺积木 ${n('needs-block')}，无法生成计划 ${n('unplannable')}，待重写 ${ds.filter((d) => d?.stale).length}，无草稿 ${ds.filter((d) => !d).length}。`);
  await writeFile(out, `${lines.join('\n')}\n`);
  console.log(`[regress] table → ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('regress-w3.ts')) void main();
