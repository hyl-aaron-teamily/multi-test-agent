// `autotest plan` / `autotest run`: Issue → draft → ONE confirmation (category, sub-cases, substitution
// checkboxes with reasons) → fixed plans in platform/plans/ → executor → report.
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runDirFor, runPlan, type RunResult } from '../executor/run';
import { openPools } from '../platform/pools';
import { type Surface, type TestPlan, TestPlanZ } from '../platform/schema/test-plan';
import { parseIssue } from '../issue/parse';
import { issuePath } from '../issue/paths';
import { loadSavedDraft, PLANS_DIR, recordWarmupFailures, saveDraft } from '../issue/drafts';
import { applyApproval, type Draft, draftIssue } from '../issue/planner';
import { normalizeResult, runMarkdown, writeIssueReport } from '../issue/report';
import { classifyRules } from '../issue/classify';
import { seriesMarkdown, type SeriesRun, summarizeSeries } from '../executor/series';
import { resolve } from 'node:path';

export { PLANS_DIR };

const flag = (a: string[], n: string) => (a.indexOf(`--${n}`) >= 0 ? a[a.indexOf(`--${n}`) + 1] : undefined);
const has = (a: string[], n: string) => a.includes(`--${n}`);

export { issuePath };

/** The confirmed draft: the saved one while the Issue file is unchanged (no model call), else a new draft
 *  (saved with its hash). `redraft` forces a new one. */
export async function loadDraft(ref: string, env: 'test' | 'prod', useModel = true, redraft = false): Promise<Draft> {
  const f = issuePath(ref);
  const id = basename(f).replace(/\.md$/, '');
  const text = await readFile(f, 'utf8');
  const saved = redraft ? undefined : loadSavedDraft(id, text, env);
  if (saved) return saved;
  return saveDraft(await draftIssue(parseIssue(id, text), { env, useModel }), text, env);
}

/** Human-readable confirmation sheet. */
export function confirmationSheet(d: Draft): string {
  const out = [`Issue ${d.issue.id}: ${d.issue.title.slice(0, 120)}${d.hash ? `  [草稿 ${d.hash}]` : ''}`, `预判类别: ${d.classification.category}（${d.classification.by}）— ${d.reason}`];
  if (d.status !== 'plannable') out.push(`处理: ${d.status === 'refused' ? '拒绝执行' : '暂缓'}`);
  for (const k of d.contracts ?? []) out.push(`  契约：前置条件 ${k.preconditions.map((p) => `${p.text}[${p.establish}]`).join('；')}`);
  if (d.deferredPart) out.push(`暂缓部分: ${d.deferredPart}`);
  for (const w of d.warmupFailures ?? []) out.push(`⚠ 上次预热失败 ${w.planId}（${w.at}）：${w.detail}`);
  for (const s of d.subcases) {
    out.push(`  [${s.substitution ? ' ' : 'x'}] ${s.sub}: ${s.plan.title} — ${s.title}`);
    if (s.substitution) out.push(`      替代: ${s.substitution.from} → ${s.substitution.alternatives.join(' | ')}（默认 ${s.surface}）`, `      理由: ${s.substitution.reason}`);
    if (s.contract) {
      const k = s.contract;
      out.push(
        `      契约（${k.provenance.by}）：前置条件 ${k.preconditions.map((p) => `${p.text}[${p.establish}]`).join('；')}`,
        `        触发：${k.trigger.semantics} — ${k.trigger.text.slice(0, 100)}`,
        `        可观察后置条件：${k.observable.observation} — 现象「${k.observable.phenomenon.slice(0, 120)}」`,
        ...(k.suspectedMechanism ? [`        推测机制（仅提示，不执行）：${k.suspectedMechanism}`] : []),
        `        计划：${s.plan.provenance.pattern ? `模式 ${s.plan.provenance.pattern}` : s.plan.provenance.generatedBy === 'model' ? '模型组合' : '通用模板'}；${s.plan.coverage === 'not-covered' ? '⚠ 计划未覆盖 Issue 现象，结论仅说明无崩溃' : '覆盖 Issue 现象'}`,
      );
    }
    if (s.planErrors.length) out.push(`      计划校验问题: ${s.planErrors.join('; ')}`);
  }
  return out.join('\n');
}

/** "--approve s1,s3:mobile-web" → [{sub:'s1'},{sub:'s3',surface:'mobile-web'}]; "all" = every sub-case. */
export function parseApprove(v: string, d: Draft): { sub: string; surface?: Surface }[] {
  if (v === 'all') return d.subcases.map((s) => ({ sub: s.sub }));
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [sub, surface] = x.split(':');
      return { sub, surface: surface as Surface | undefined };
    })
    .filter((a) => d.subcases.some((s) => s.sub === a.sub));
}

async function ask(d: Draft): Promise<{ sub: string; surface?: Surface }[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = d.subcases.some((s) => s.substitution) ? '勾选要执行的子用例（如 s1,s3:mobile-web；all；回车=取消）: ' : '执行全部子用例？[y/N] ';
    const ans = (await rl.question(hint)).trim();
    if (!ans) return [];
    if (/^y(es)?$/i.test(ans)) return d.subcases.map((s) => ({ sub: s.sub }));
    return parseApprove(ans, d);
  } finally {
    rl.close();
  }
}

export async function savePlans(plans: TestPlan[]): Promise<string[]> {
  await mkdir(PLANS_DIR, { recursive: true });
  const out: string[] = [];
  for (const p of plans) {
    const f = join(PLANS_DIR, `${p.id}.json`);
    await writeFile(f, JSON.stringify(p, null, 2));
    out.push(f);
  }
  return out;
}

export async function planCmd(args: string[]): Promise<number> {
  const ref = args.find((a) => !a.startsWith('--'));
  if (!ref) throw new Error('usage: autotest plan issues/<id>.md [--env prod] [--json] [--no-model]');
  const env = (flag(args, 'env') ?? 'prod') as 'test' | 'prod';
  // `plan` always drafts anew (that is its job); `run` reuses the confirmed draft.
  const d = await loadDraft(ref, env, !has(args, 'no-model'), true);
  if (d.status !== 'plannable') {
    const dir = runDirFor(d.issue.id);
    const f = await writeIssueReport(d, [], dir);
    console.log(confirmationSheet(d));
    console.log(`[plan] ${d.status} report → ${f}`);
    return 0;
  }
  if (has(args, 'json')) console.log(JSON.stringify(d, null, 2));
  else console.log(confirmationSheet(d));
  console.log(`[plan] draft → ${join(PLANS_DIR, 'drafts', `${d.issue.id}.json`)}`);
  return 0;
}

export async function runIssue(d: Draft, approve: { sub: string; surface?: Surface }[], o: { headed?: boolean; maxSteps?: number; maxMinutes?: number; maxRounds?: number; udid?: string; taskId?: string; log?: (s: string) => void; dir?: string }): Promise<{ dir: string; results: RunResult[]; report: string }> {
  const dir = o.dir ?? runDirFor(d.issue.id);
  if (d.status !== 'plannable') return { dir, results: [], report: await writeIssueReport(d, [], dir) };
  // Confirmation = execution: approved plans are frozen to files (with the draft hash) and the executor runs
  // exactly what is read back from them.
  const files = await savePlans(applyApproval(d, approve));
  const plans = files.map((f) => TestPlanZ.parse(JSON.parse(readFileSync(f, 'utf8'))));
  for (const p of plans) if (p.provenance.draftHash !== d.hash) throw new Error(`plan ${p.id}: draft hash ${p.provenance.draftHash} ≠ confirmed ${d.hash}`);
  const { pool, devices } = await openPools();
  const results: RunResult[] = [];
  for (const p of plans) {
    (o.log ?? console.log)(`[run] plan ${p.id} (${p.category}, ${p.surface}${p.substitution ? `, 替代 ${p.substitution.from}` : ''}, env ${p.env})`);
    const r = await runPlan({ plan: p, runDir: join(dir, p.id), pool, devices, udid: o.udid, headed: o.headed, maxSteps: o.maxSteps, maxMinutes: o.maxMinutes, maxRounds: o.maxRounds, taskId: o.taskId, log: o.log });
    (o.log ?? console.log)(`[run] ${p.id}: ${r.conclusion} — ${r.conclusionDetail}${r.error ? ` (error: ${r.error})` : ''}`);
    results.push(r);
  }
  // Warm-up gate feedback: a plan that is not executable on the current UI goes back to the draft.
  const failed = results.filter((r) => r.conclusion === '计划不可执行').map((r) => ({ planId: r.planId, at: r.finishedAt, detail: r.conclusionDetail }));
  if (await recordWarmupFailures(d.issue.id, d.hash, failed)) d.warmupFailures = [...(d.warmupFailures ?? []), ...failed];
  return { dir, results, report: await writeIssueReport(d, results, dir) };
}

export async function runCmd(args: string[]): Promise<number> {
  const ref = flag(args, 'issue') ?? args.find((a) => !a.startsWith('--'));
  if (!ref) throw new Error('usage: autotest run --issue <id> [--approve s1,s2:mobile-web|all] [--yes] [--env prod] [--redraft] [--draft <hash>]');
  const env = (flag(args, 'env') ?? 'prod') as 'test' | 'prod';
  const d = await loadDraft(ref, env, !has(args, 'no-model'), has(args, 'redraft'));
  console.log(confirmationSheet(d));
  // The console confirms a draft by its hash: refuse to run anything else.
  const want = flag(args, 'draft');
  if (want && want !== d.hash) throw new Error(`draft ${d.hash} is not the confirmed draft ${want} — confirm again`);
  let approve: { sub: string; surface?: Surface }[] = [];
  if (d.status === 'plannable') {
    const subst = d.subcases.some((s) => s.substitution);
    if (flag(args, 'approve')) approve = parseApprove(flag(args, 'approve')!, d);
    else if (has(args, 'yes') && !subst) approve = d.subcases.map((s) => ({ sub: s.sub }));
    else if (process.stdin.isTTY) approve = await ask(d);
    else throw new Error(subst ? 'substitution needs explicit approval: --approve <sub[:surface],...>' : 'confirm with --yes or --approve');
    if (!approve.length) {
      console.log('[run] nothing approved — cancelled');
      return 0;
    }
    console.log(`[run] approved: ${approve.map((a) => `${a.sub}${a.surface ? `:${a.surface}` : ''}`).join(', ')}`);
  }
  const num = (n: string) => (flag(args, n) ? Number(flag(args, n)) : undefined);
  const { report, results } = await runIssue(d, approve, { headed: has(args, 'headed'), maxSteps: num('max-steps'), maxMinutes: num('max-minutes'), maxRounds: num('max-rounds'), udid: flag(args, 'device'), taskId: flag(args, 'id') });
  console.log(`[run] report → ${report}`);
  return results.some((r) => r.conclusion === '执行失败' || r.conclusion === 'SKILL 失效' || r.conclusion === '计划不可执行' || r.conclusion === '环境不合格') ? 3 : results.some((r) => r.conclusion === '已复现') ? 1 : 0;
}

/** `autotest series --issue <id> --approve <sub>:<surface> --runs N [--max-rounds N]` (W2-2 §3.4): N independent
 *  runs of ONE confirmed sub-case, strictly one after another, then series-report.md / series.json. */
export async function seriesCmd(args: string[]): Promise<number> {
  const ref = flag(args, 'issue');
  const approveArg = flag(args, 'approve');
  if (!ref || !approveArg) throw new Error('usage: autotest series --issue <id> --approve <sub>[:<surface>] --runs N [--max-rounds N] [--env prod] [--device <udid>] [--draft <hash>]');
  const env = (flag(args, 'env') ?? 'prod') as 'test' | 'prod';
  const n = Number(flag(args, 'runs') ?? 10);
  if (!(Number.isInteger(n) && n >= 1 && n <= 50)) throw new Error('--runs: 1..50');
  const d = await loadDraft(ref, env, !has(args, 'no-model'), false);
  const want = flag(args, 'draft');
  if (want && want !== d.hash) throw new Error(`draft ${d.hash} is not the confirmed draft ${want} — confirm again`);
  if (d.status !== 'plannable') throw new Error(`Issue ${d.issue.id} is ${d.status}: nothing to run`);
  const approve = parseApprove(approveArg, d);
  if (approve.length !== 1) throw new Error('a series runs exactly one sub-case: --approve <sub>[:<surface>]');
  const sub = d.subcases.find((s) => s.sub === approve[0].sub)!;
  const surface = approve[0].surface ?? sub.surface;
  const num = (k: string) => (flag(args, k) ? Number(flag(args, k)) : undefined);
  const dir = resolve('midscene_run/series', `${d.issue.id}-${sub.sub}-${surface}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const runs: SeriesRun[] = [];
  const write = async () => {
    const md = seriesMarkdown({ issue: d.issue.id, sub: sub.sub, surface, env, runs, dir, startedAt, finishedAt: new Date().toISOString() });
    await writeFile(join(dir, 'series-report.md'), md);
    await writeFile(join(dir, 'series.json'), JSON.stringify({ issue: d.issue.id, sub: sub.sub, surface, env, draftHash: d.hash, startedAt, summary: summarizeSeries(runs), runs: runs.map((r) => ({ index: r.index, dir: r.dir, error: r.error, conclusion: r.result?.conclusion, runTag: r.result?.runTag, attempts: r.result?.attempts, failure: r.result?.failure, phases: r.result?.phases })) }, null, 2));
  };
  for (let i = 1; i <= n; i++) {
    const runDir = join(dir, `run-${String(i).padStart(2, '0')}`);
    console.log(`[series] run ${i}/${n} → ${runDir}`);
    try {
      const { results } = await runIssue(d, approve, { maxSteps: num('max-steps'), maxMinutes: num('max-minutes'), maxRounds: num('max-rounds'), udid: flag(args, 'device'), taskId: flag(args, 'id') ? `${flag(args, 'id')}-${i}` : undefined, dir: runDir });
      const r = results[0];
      runs.push({ index: i, dir: runDir, result: r });
      console.log(`[series] run ${i}: ${r?.conclusion ?? '-'} — ${r?.conclusionDetail ?? ''}${r?.failure ? ` [${r.failure.kind}:${r.failure.rule}]` : ''}`);
    } catch (e) {
      runs.push({ index: i, dir: runDir, error: (e as Error).message.split('\n')[0] });
      console.log(`[series] run ${i}: exception — ${(e as Error).message.split('\n')[0]}`);
    }
    await write();
  }
  const s = summarizeSeries(runs);
  console.log(`[series] summary: 工具可靠性 ${s.reachedLoop}/${s.counted}（环境不合格 ${s.envUnfit}）；复现 ${s.reproducedRuns}/${s.validRuns}；有效尝试 ${s.pooled.valid}、命中 ${s.pooled.hits}`);
  console.log(`[series] report → ${join(dir, 'series-report.md')}`);
  return s.counted && s.reachedLoop / s.counted >= 0.9 ? 0 : 3;
}

/** `autotest rerender <runDir>`: an old Issue run's result.json → report.v2.md with the W2-2 wording. */
export async function rerenderCmd(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) throw new Error('usage: autotest rerender <issue run dir with result.json>');
  const res = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as { issue: string; status: Draft['status']; category: string; reason: string; deferredPart?: string; results: RunResult[] };
  const text = await readFile(issuePath(res.issue), 'utf8').catch(() => '');
  const issue = parseIssue(res.issue, text);
  const d: Draft = { issue, classification: { ...classifyRules(issue), category: res.category as Draft['classification']['category'] }, status: res.status, reason: res.reason, subcases: [], deferredPart: res.deferredPart };
  const md = runMarkdown(d, res.results.map(normalizeResult), dir);
  const out = join(dir, 'report.v2.md');
  await writeFile(out, md);
  console.log(`[rerender] ${res.results.map((r) => `${r.planId}: ${r.conclusion} → ${normalizeResult(r).conclusion}`).join('; ')}`);
  console.log(`[rerender] → ${out}`);
  return 0;
}
