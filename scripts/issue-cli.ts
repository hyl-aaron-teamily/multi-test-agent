// `autotest plan` / `autotest run`: Issue → draft → ONE confirmation (category, sub-cases, substitution
// checkboxes with reasons) → fixed plans in platform/plans/ → executor → report.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runDirFor, runPlan, type RunResult } from '../executor/run';
import { openPools } from '../platform/pools';
import type { Surface, TestPlan } from '../platform/schema/test-plan';
import { parseIssue } from '../issue/parse';
import { issuePath } from '../issue/paths';
import { applyApproval, type Draft, draftIssue } from '../issue/planner';
import { writeIssueReport } from '../issue/report';

export const PLANS_DIR = resolve('platform/plans');

const flag = (a: string[], n: string) => (a.indexOf(`--${n}`) >= 0 ? a[a.indexOf(`--${n}`) + 1] : undefined);
const has = (a: string[], n: string) => a.includes(`--${n}`);

export { issuePath };

export async function loadDraft(ref: string, env: 'test' | 'prod', useModel = true): Promise<Draft> {
  const f = issuePath(ref);
  const id = basename(f).replace(/\.md$/, '');
  return draftIssue(parseIssue(id, await readFile(f, 'utf8')), { env, useModel });
}

/** Human-readable confirmation sheet. */
export function confirmationSheet(d: Draft): string {
  const out = [`Issue ${d.issue.id}: ${d.issue.title.slice(0, 120)}`, `预判类别: ${d.classification.category}（${d.classification.by}）— ${d.reason}`];
  if (d.status !== 'plannable') out.push(`处理: ${d.status === 'refused' ? '拒绝执行' : '暂缓'}`);
  if (d.deferredPart) out.push(`暂缓部分: ${d.deferredPart}`);
  for (const s of d.subcases) {
    out.push(`  [${s.substitution ? ' ' : 'x'}] ${s.sub}: ${s.plan.title} — ${s.title}`);
    if (s.substitution) out.push(`      替代: ${s.substitution.from} → ${s.substitution.alternatives.join(' | ')}（默认 ${s.surface}）`, `      理由: ${s.substitution.reason}`);
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
  const d = await loadDraft(ref, env, !has(args, 'no-model'));
  await mkdir(join(PLANS_DIR, 'drafts'), { recursive: true });
  await writeFile(join(PLANS_DIR, 'drafts', `${d.issue.id}.json`), JSON.stringify(d, null, 2));
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

export async function runIssue(d: Draft, approve: { sub: string; surface?: Surface }[], o: { headed?: boolean; maxSteps?: number; maxMinutes?: number; udid?: string; taskId?: string; log?: (s: string) => void }): Promise<{ dir: string; results: RunResult[]; report: string }> {
  const dir = runDirFor(d.issue.id);
  if (d.status !== 'plannable') return { dir, results: [], report: await writeIssueReport(d, [], dir) };
  const plans = applyApproval(d, approve);
  await savePlans(plans);
  const { pool, devices } = await openPools();
  const results: RunResult[] = [];
  for (const p of plans) {
    (o.log ?? console.log)(`[run] plan ${p.id} (${p.category}, ${p.surface}${p.substitution ? `, 替代 ${p.substitution.from}` : ''}, env ${p.env})`);
    const r = await runPlan({ plan: p, runDir: join(dir, p.id), pool, devices, udid: o.udid, headed: o.headed, maxSteps: o.maxSteps, maxMinutes: o.maxMinutes, taskId: o.taskId, log: o.log });
    (o.log ?? console.log)(`[run] ${p.id}: ${r.conclusion} — ${r.conclusionDetail}${r.error ? ` (error: ${r.error})` : ''}`);
    results.push(r);
  }
  return { dir, results, report: await writeIssueReport(d, results, dir) };
}

export async function runCmd(args: string[]): Promise<number> {
  const ref = flag(args, 'issue') ?? args.find((a) => !a.startsWith('--'));
  if (!ref) throw new Error('usage: autotest run --issue <id> [--approve s1,s2:mobile-web|all] [--yes] [--env prod]');
  const env = (flag(args, 'env') ?? 'prod') as 'test' | 'prod';
  const d = await loadDraft(ref, env, !has(args, 'no-model'));
  console.log(confirmationSheet(d));
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
  const { report, results } = await runIssue(d, approve, { headed: has(args, 'headed'), maxSteps: num('max-steps'), maxMinutes: num('max-minutes'), udid: flag(args, 'device'), taskId: flag(args, 'id') });
  console.log(`[run] report → ${report}`);
  return results.some((r) => r.conclusion === '执行失败' || r.conclusion === 'SKILL 失效') ? 3 : results.some((r) => r.conclusion === '已复现') ? 1 : 0;
}
