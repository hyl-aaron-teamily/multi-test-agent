// Round-end checkpoint: evaluates the plan's checks once per round (never per step). Screenshot only
// when a check needs the screen; the round-1 baseline of a quote jump is kept here.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, type Rgba } from '../core/image';
import { AndroidDriver } from '../drivers/android';
import type { CheckPoint } from '../platform/schema/test-plan';
import { type CheckResult, evaluateAi, evaluateVisual, regionMatch } from './checks';
import type { RunCtx } from './context';
import { type Observed, observationOf, observeKeyboard, observeText } from './observe';
import { addTier } from './stats';
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
      const t0 = Date.now();
      let r: Observed | undefined;
      if (k.kind === 'visual-region' && png) r = await evaluateVisual(d, profile, k, c.ask, png);
      else if (k.kind === 'ai' && png && k.onlyOnAnomaly === false) r = { ...(await evaluateAi(k, c.ask)), tier: '③' };
      else if (k.kind === 'process-alive' && inner instanceof AndroidDriver) {
        const alive = await inner.processAlive();
        r = { check: k, pass: k.want === 'absent' ? !alive : alive, detail: `process ${alive ? 'running' : 'not running'}`, tier: '①' };
      } else if (k.kind === 'baseline' && png) r = { ...(await this.baselineCheck(k, png)), tier: '①' };
      else if (k.kind === 'keyboard') r = await observeKeyboard(inner, k);
      else if (k.kind === 'text') r = await observeText(inner, k, c.targets, profile.viewport.width);
      if (!r) continue;
      r.tier ??= r.vision ? '③' : '①';
      r.ms ??= Date.now() - t0;
      addTier((c.stats.observeTiers ??= {}), `${r.tier} ${observationOf(k)}`, r.ms);
      results.push(r);
    }
    return results;
  }

  private async baselineCheck(k: CheckPoint, png: Buffer): Promise<CheckResult> {
    const { c } = this;
    const inner = c.sess.inner;
    if (!this.baseline) {
      const quoted = c.res.targets.find((t) => t.kind === 'quote-card')?.chosen.match(/^quote of "(.*)"$/)?.[1] ?? '';
      let box = inner instanceof AndroidDriver && quoted ? await quotedOriginalVisible(inner, quoted) : undefined;
      if (!(inner instanceof AndroidDriver)) {
        // Web: no accessibility read of the jump target — the vision model confirms the first landing once (③),
        // then the content area of that screen is the reference for later rounds (①).
        const src = String(c.plan.prepare.find((x) => x.node?.name === 'teamily.quoteReply')?.node?.input?.quote ?? '');
        const ok = await c.ask?.(src ? `A message bubble with the text "${src}" (the quoted original message itself, not only the small quote block inside a reply) is visible on screen` : 'After tapping the quote block of a reply, the chat now shows the original quoted message (often briefly highlighted), not some unrelated older part of the history');
        const img = decodePng(png);
        const dpr = img.width / c.sess.profile.viewport.width;
        if (ok) box = [0, Math.round(img.height * 0.15), img.width, Math.round(img.height * 0.6)].map((v) => Math.round(v / (dpr || 1))) as [number, number, number, number];
      }
      this.baseline = { img: decodePng(png), box };
      await writeFile(join(c.o.runDir, 'baseline.png'), png);
      return { check: k, pass: !!box, detail: box ? `first jump shows the quoted original at ${JSON.stringify(box)} (accessibility check) — kept as reference` : 'first jump does NOT show the quoted original message' };
    }
    if (!this.baseline.box) return { check: k, pass: false, detail: 'no reference: the first jump already failed' };
    // 0.35: the jump briefly highlights the target bubble (tint differs by capture moment); another screen scores ~0.7.
    const dpr = c.sess.inner instanceof AndroidDriver ? 1 : this.baseline.img.width / c.sess.profile.viewport.width;
    const m = regionMatch(decodePng(png), this.baseline.img, this.baseline.box, dpr, 900);
    return { check: k, pass: m.fraction <= BASELINE_TOLERANCE, detail: `quoted original ${m.fraction <= BASELINE_TOLERANCE ? `visible (dy ${m.dy})` : `NOT on screen (${Math.round(m.fraction * 100)}% of its marks missing)`}` };
  }
}
