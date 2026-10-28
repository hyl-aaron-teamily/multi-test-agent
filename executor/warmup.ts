// Warm-up round (W2-1 §6.1): before the loop, run the plan's actions once and verify after EACH step that
// its expected effect appeared (tiered observation). A step whose effect never shows (one redo allowed)
// makes the plan "计划不可执行" — the loop is not entered and no "未复现" is reported; the failure goes
// back to the draft. Each tap point's element fingerprint is recorded (warmup.json). Warm-up time is not
// an action interval; hard anomalies count as hits as usual; its checkpoint result is recorded only.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, pixelDiff } from '../core/image';
import { dumpTree, keyboardShown, nodeAt, type UiNode } from '../core/ui-tree';
import { AndroidDriver } from '../drivers/android';
import { HARD_ANOMALIES, type Point, RoundDrift, sleep } from '../drivers/types';
import { incidentKind } from '../incident/bundle';
import type { PlannedAction } from '../platform/schema/test-plan';
import { nodeSpec } from '../skills/teamily/node-specs';
import { ELEMENTS } from '../skills/teamily/vocab';
import { actionLabel, resolvePoint } from './actions';
import { waitForRegion } from './checks';
import { Checkpoint } from './checkpoint';
import type { RunCtx } from './context';
import { recordIncident } from './incident-hook';
import { healElement } from './heal';

export interface WarmupStep {
  step: number;
  action: string;
  expected: string;
  observed: string;
  pass: boolean | null;
  tier?: string;
  ms: number;
  point?: Point;
  fingerprint?: { text: string; desc: string; cls: string };
  redo?: boolean;
  healed?: string;
}

/** Fraction of the screen's pixels a navigation / popup changes at least. */
export const CHANGE_FRACTION = 0.01;

export class WarmupError extends Error {
  constructor(
    readonly step: WarmupStep,
    readonly steps: WarmupStep[],
  ) {
    super(`计划不可执行（预热第 ${step.step} 步：${step.action} 预期 ${step.expected} 未出现 — ${step.observed}）`);
    this.name = 'WarmupError';
  }
}

/** Pure: the effect a step should have, or undefined when it is not verified. */
export function expectedEffect(a: PlannedAction): { kind: 'region'; key: string } | { kind: 'change' | 'navigate' | 'soft-change' | 'focus' | 'foreground-left' | 'process-gone' | 'process-up' } | undefined {
  if (a.type === 'node') {
    const e = nodeSpec(a.node?.name ?? '')?.effect;
    return e ? { kind: 'region', key: `${e.page}/${e.region}` } : undefined;
  }
  if (a.type === 'exitApp') return { kind: 'foreground-left' };
  if (a.type === 'killApp') return { kind: 'process-gone' };
  if (a.type === 'launch') return { kind: 'process-up' };
  if ((a.type === 'tap' || a.type === 'longPress') && a.element) {
    // Tapping a frozen target (a quote block, a reaction) or long-pressing one changes the screen.
    if (a.element.startsWith('target.')) return a.type === 'longPress' ? { kind: 'change' } : { kind: 'soft-change' };
    const s = ELEMENTS.find((e) => e.id === a.element)?.selfCheck;
    return s === 'navigate' ? { kind: 'navigate' } : s === 'popup' ? { kind: 'change' } : s === 'focus' ? { kind: 'focus' } : undefined;
  }
  return undefined;
}

const describeEffect = (e: NonNullable<ReturnType<typeof expectedEffect>>) =>
  e.kind === 'region' ? `参考区域 ${e.key} 出现` : e.kind === 'change' ? '画面变化' : e.kind === 'navigate' ? '页面切换' : e.kind === 'soft-change' ? '画面变化（目标已在视野内时可无变化）' : e.kind === 'focus' ? '获得焦点 / 键盘弹出' : e.kind === 'foreground-left' ? '离开前台' : e.kind === 'process-gone' ? '进程结束' : '进程在运行';

/** Point an action taps (for its fingerprint), if any. */
function tapPoint(c: RunCtx, a: PlannedAction): Point | undefined {
  try {
    if (a.element) return resolvePoint(a.element, c.sess.profile, c.targets);
    const t = a.node?.input?.target;
    if (typeof t === 'string' && c.targets[t]) return c.targets[t];
  } catch {
    /* not resolvable: no fingerprint */
  }
  return undefined;
}

export async function runWarmup(c: RunCtx): Promise<WarmupStep[]> {
  const { d, inner, profile } = c.sess;
  const android = inner instanceof AndroidDriver ? inner : undefined;
  const web = c.sess.web?.page ? c.sess.web : undefined;
  const steps: WarmupStep[] = [];
  d.round = 0;
  c.log(`warm-up: ${c.plan.actions.length} steps with per-step verification`);
  for (const [i, a] of c.plan.actions.entries()) {
    const t0 = Date.now();
    const eff = expectedEffect(a);
    const pt = tapPoint(c, a);
    let nodes: UiNode[] = [];
    if (android && pt) nodes = await dumpTree(android.o.udid, android.o.packageName, 2);
    const fp = pt ? nodeAt(nodes, pt.x, pt.y) : undefined;
    const st: WarmupStep = { step: i + 1, action: actionLabel(a), expected: eff ? describeEffect(eff) : '（不核验）', observed: '', pass: null, ms: 0, point: pt, fingerprint: fp ? { text: fp.text, desc: fp.desc, cls: fp.cls } : undefined };
    const attempt = async () => {
      const url0 = web?.page?.url() ?? '';
      const before = eff?.kind === 'change' || eff?.kind === 'navigate' || eff?.kind === 'soft-change' || (eff?.kind === 'focus' && android) ? decodePng(await d.screenshot()) : undefined;
      d.label = `warmup:${actionLabel(a)}`;
      try {
        await c.exec(a);
      } catch (e) {
        // The step's input did not land / the round precondition does not hold: the step failed.
        if (e instanceof RoundDrift) return { pass: false as boolean | null, observed: e.message, tier: '①' as string | undefined };
        throw e;
      }
      if (!eff) return { pass: null as boolean | null, observed: 'not verified', tier: undefined as string | undefined };
      await sleep(600);
      switch (eff.kind) {
        case 'region': {
          const hit = await waitForRegion(d, profile, [eff.key], 6000, 800);
          return { pass: !!hit, observed: hit ? `${eff.key} on screen` : `${eff.key} not on screen`, tier: '① region' };
        }
        case 'change': {
          const after = decodePng(await d.screenshot());
          const px = pixelDiff(before!, after);
          // A real page change moves far more than cursor / hover / caret noise (desktop: ~12k px of 3.6M).
          const min = Math.max(2000, Math.round(after.width * after.height * CHANGE_FRACTION));
          return { pass: px >= min, observed: `screen Δ${px}px (min ${min})`, tier: '① pixels' };
        }
        case 'navigate': {
          // Web: the route changes (page noise such as hover / loading moves as many pixels as a real
          // navigation on a large desktop screen); phones: the screen changes.
          if (web) {
            const ok = web.page!.url() !== url0;
            return { pass: ok, observed: `url ${ok ? 'changed' : 'same'} (${new URL(web.page!.url()).pathname})`, tier: '① url' };
          }
          const after = decodePng(await d.screenshot());
          const px = pixelDiff(before!, after);
          const min = Math.max(2000, Math.round(after.width * after.height * CHANGE_FRACTION));
          return { pass: px >= min, observed: `screen Δ${px}px (min ${min})`, tier: '① pixels' };
        }
        case 'soft-change': {
          // Tapping a frozen target (e.g. a quote whose source is already in view) may legitimately change
          // nothing: a change verifies the step, no change leaves it unverified (never gates the plan).
          const after = decodePng(await d.screenshot());
          const px = pixelDiff(before!, after);
          const min = Math.max(2000, Math.round(after.width * after.height * CHANGE_FRACTION));
          return { pass: px >= min ? true : null, observed: `screen Δ${px}px (min ${min})${px >= min ? '' : ' — no visible change, not verified'}`, tier: '① pixels' };
        }
        case 'focus': {
          // Focus = the keyboard comes up, or (e.g. the App's search box) a page opens.
          if (android) {
            const k = await keyboardShown(android.o.udid);
            if (k) return { pass: true, observed: 'keyboard shown', tier: '① system' };
            const after = decodePng(await d.screenshot());
            const px = pixelDiff(before!, after);
            const min = Math.max(2000, Math.round(after.width * after.height * CHANGE_FRACTION));
            return { pass: px >= min, observed: `keyboard ${k === null ? 'unknown' : 'not shown'}, screen Δ${px}px (min ${min})`, tier: '① system + pixels' };
          }
          return { pass: null, observed: 'focus not observable here', tier: undefined };
        }
        case 'foreground-left':
          return { pass: android ? !android.foreground : null, observed: android ? `foreground ${android.foreground ? 'still the app' : 'left'}` : '-', tier: '① logcat' };
        case 'process-gone':
        case 'process-up': {
          const alive = android ? await android.processAlive() : null;
          const want = eff.kind === 'process-up';
          return { pass: alive === null ? null : alive === want, observed: `process ${alive ? 'running' : 'not running'}`, tier: '① pidof' };
        }
      }
    };
    let r = await attempt();
    if (r.pass === false) {
      // One redo; a fixed element first gets a fingerprint re-resolve (self-heal) when it has one.
      if (a.element && !a.element.startsWith('target.')) {
        const h = await healElement(c, a.element);
        if (h) st.healed = h;
      }
      st.redo = true;
      r = await attempt();
    }
    st.pass = r.pass;
    st.observed = r.observed;
    st.tier = r.tier;
    st.ms = Date.now() - t0;
    steps.push(st);
    c.log(`warm-up ${st.step} ${st.action}: ${st.pass === null ? '—' : st.pass ? 'ok' : 'FAILED'} (${st.observed})`);
    for (const x of d.drainAnomalies())
      if (HARD_ANOMALIES.includes(x.kind)) {
        c.res.hits.push({ round: 0, step: st.step, at: new Date().toISOString(), reason: `${x.kind} during warm-up: ${x.detail.slice(0, 200)}` });
        c.res.incidents.push(await recordIncident(c, incidentKind(x.kind), x.detail, 0));
      }
    if (st.pass === false) {
      await writeFile(join(c.o.runDir, 'warmup.json'), JSON.stringify(steps, null, 2));
      await writeFile(join(c.o.runDir, `warmup-failed-step-${st.step}.png`), await d.screenshot()).catch(() => {});
      throw new WarmupError(st, steps);
    }
  }
  // Checkpoint once (recorded only; a separate instance so a quote-jump baseline is still taken in round 1).
  const png = await d.screenshot();
  const results = await new Checkpoint(c).evaluate(png);
  c.res.warmup = { steps, checks: results.map((x) => ({ kind: x.check.kind, pass: x.pass, detail: x.detail })) };
  for (const a of c.plan.afterCheck) {
    d.label = `warmup-after:${actionLabel(a)}`;
    await c.exec(a);
  }
  await writeFile(join(c.o.runDir, 'warmup.json'), JSON.stringify(c.res.warmup, null, 2));
  c.log(`warm-up passed (${steps.filter((s) => s.pass).length}/${steps.filter((s) => s.pass !== null).length} verified steps)`);
  return steps;
}
