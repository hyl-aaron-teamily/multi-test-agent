// One-off phases: feature acceptance (each item once) and the correct path of a suspected misuse.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HARD_ANOMALIES } from '../drivers/types';
import { actionLabel } from './actions';
import { type CheckResult, evaluateAi, evaluateVisual } from './checks';
import type { RunCtx } from './context';
import { featureConclusion } from './verdict';

export async function runAcceptance(c: RunCtx): Promise<void> {
  const { d, profile } = c.sess;
  const shotDir = join(c.o.runDir, 'evidence');
  await mkdir(shotDir, { recursive: true });
  c.res.acceptance = [];
  for (const item of c.plan.acceptance ?? []) {
    for (const a of item.actions) {
      d.label = actionLabel(a);
      c.stats.steps++;
      await c.exec(a);
    }
    const png = await d.screenshot();
    c.stats.checkpointScreenshots++;
    await writeFile(join(shotDir, `${item.id}.png`), png);
    const r = item.check.kind === 'ai' ? await evaluateAi(item.check, c.ask) : await evaluateVisual(d, profile, { ...item.check, onlyOnAnomaly: item.check.onlyOnAnomaly ?? false }, undefined, png);
    c.res.acceptance.push({ id: item.id, text: item.text, pass: r.pass, detail: r.detail, evidence: `evidence/${item.id}.png` });
    c.log(`acceptance ${item.id}: ${r.pass === null ? '未验证' : r.pass ? '满足' : '不满足'} — ${r.detail}`);
  }
  c.res.conclusion = featureConclusion(c.res.acceptance);
  const miss = c.res.acceptance.filter((x) => x.pass === false).map((x) => x.text);
  const unv = c.res.acceptance.filter((x) => x.pass === null).map((x) => x.text);
  c.res.conclusionDetail = `${miss.length ? `缺项：${miss.join('；')}` : '无缺项'}${unv.length ? `；未验证：${unv.join('；')}` : ''}`;
}

/** suspected-misuse: the correct path first, once, with the same checks. undefined = no correct path. */
export async function runCorrectPath(c: RunCtx): Promise<boolean | undefined> {
  if (c.plan.category !== 'suspected-misuse' || !c.plan.correctPath?.length) return undefined;
  const { d, profile } = c.sess;
  for (const a of c.plan.correctPath) {
    d.label = `correct:${actionLabel(a)}`;
    await c.exec(a);
  }
  const png = await d.screenshot();
  c.stats.checkpointScreenshots++;
  const rs: CheckResult[] = [];
  for (const k of c.plan.checks)
    if (k.kind === 'visual-region') rs.push(await evaluateVisual(d, profile, k, c.ask, png));
    else if (k.kind === 'ai') rs.push(await evaluateAi(k, c.ask));
  const ok = !rs.some((x) => x.pass === false) && !d.drainAnomalies().some((x) => HARD_ANOMALIES.includes(x.kind));
  c.log(`correct path: ${ok ? 'normal' : 'also shows the problem'}`);
  return ok;
}
