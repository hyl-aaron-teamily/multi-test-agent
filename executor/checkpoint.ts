// Round-end checkpoint: evaluates the plan's checks once per round (never per step). Screenshot only
// when a check needs the screen; the round-1 baseline of a quote jump is kept here.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, type Rgba } from '../core/image';
import { AndroidDriver } from '../drivers/android';
import type { CheckPoint } from '../platform/schema/test-plan';
import { type CheckResult, evaluateAi, evaluateVisual, regionMatch } from './checks';
import type { RunCtx } from './context';
import { quotedOriginalVisible } from './targets';

/** Baseline check: fraction of the reference bubble's marks that may be missing. Diagnostic override
 *  AUTOTEST_BASELINE_TOLERANCE (e.g. 0.05 restores the strict pre-fix threshold that raised 1329's false hits). */
const BASELINE_TOLERANCE = Number(process.env.AUTOTEST_BASELINE_TOLERANCE ?? 0.35);

/** Pure: does any check of the plan need a round-end screenshot? */
export const needsScreenshot = (checks: CheckPoint[]) => checks.some((c) => c.kind === 'visual-region' || c.kind === 'baseline' || c.kind === 'ai');

export class Checkpoint {
  // 'baseline': round 1 verifies the landing screen once (accessibility read of the quoted original) and
  // keeps it; later rounds must land on the same screen.
  private baseline?: { img: Rgba; box?: [number, number, number, number] };

  constructor(private c: RunCtx) {}

  async evaluate(png: Buffer | undefined): Promise<CheckResult[]> {
    const { c } = this;
    const { d, profile, inner } = c.sess;
    const results: CheckResult[] = [];
    for (const k of c.plan.checks) {
      if (k.kind === 'visual-region' && png) results.push(await evaluateVisual(d, profile, k, c.ask, png));
      else if (k.kind === 'ai' && png && k.onlyOnAnomaly === false) results.push(await evaluateAi(k, c.ask));
      else if (k.kind === 'process-alive' && inner instanceof AndroidDriver) {
        const alive = await inner.processAlive();
        results.push({ check: k, pass: k.want === 'absent' ? !alive : alive, detail: `process ${alive ? 'running' : 'not running'}` });
      } else if (k.kind === 'baseline' && png) results.push(await this.baselineCheck(k, png));
    }
    return results;
  }

  private async baselineCheck(k: CheckPoint, png: Buffer): Promise<CheckResult> {
    const { c } = this;
    const inner = c.sess.inner;
    if (!this.baseline) {
      const quoted = c.res.targets.find((t) => t.kind === 'quote-card')?.chosen.match(/^quote of "(.*)"$/)?.[1] ?? '';
      const box = inner instanceof AndroidDriver && quoted ? await quotedOriginalVisible(inner, quoted) : undefined;
      this.baseline = { img: decodePng(png), box };
      await writeFile(join(c.o.runDir, 'baseline.png'), png);
      return { check: k, pass: !!box, detail: box ? `first jump shows the quoted original at ${JSON.stringify(box)} (accessibility check) — kept as reference` : 'first jump does NOT show the quoted original message' };
    }
    if (!this.baseline.box) return { check: k, pass: false, detail: 'no reference: the first jump already failed' };
    // 0.35: the jump briefly highlights the target bubble (tint differs by capture moment); another screen scores ~0.7.
    const m = regionMatch(decodePng(png), this.baseline.img, this.baseline.box, 1, 900);
    return { check: k, pass: m.fraction <= BASELINE_TOLERANCE, detail: `quoted original ${m.fraction <= BASELINE_TOLERANCE ? `visible (dy ${m.dy})` : `NOT on screen (${Math.round(m.fraction * 100)}% of its marks missing)`}` };
  }
}
