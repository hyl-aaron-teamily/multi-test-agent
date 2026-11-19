// Warm-up round (W2-1 §6.1): before the loop, run the plan's actions once and verify after EACH step that
// its expected effect appeared (tiered observation). A step whose effect never shows (one redo allowed)
// makes the plan "计划不可执行" — the loop is not entered and no "未复现" is reported; the failure goes
// back to the draft. Each tap point's element fingerprint is recorded (warmup.json). Warm-up time is not
// an action interval; hard anomalies count as hits as usual; its checkpoint result is recorded only.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, pixelDiff } from '../../core/image';
import { dumpTree, keyboardShown, nodeAt, type UiNode } from '../../core/ui-tree';
import { AndroidDriver } from '../../drivers/android';
import { type FailureKind, HARD_ANOMALIES, type Point, RoundDrift, sleep } from '../../drivers/types';
import { incidentKind } from '../recorder/bundle';
import type { PlannedAction } from '../../platform/schema/test-plan';
import { nodeSpec } from '../../skills/teamily/node-specs';
import { ELEMENTS } from '../../skills/teamily/vocab';
import { actionLabel, resolvePoint } from './actions';
import { waitForRegion } from '../checks';
import { Checkpoint } from './checkpoint';
import type { RunCtx } from './context';
import { recordIncident } from '../recorder/incident-hook';
import { observeCheck } from './checkpoint';
import { readBaseline, readExpect } from './expect';
import { restore } from './loop';

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
  /** W3-1: the action's post-condition read in the warm-up. */
  expect?: { role: string; pass: boolean | null; detail: string };
  /** W3-7 §8.1 ①: the plan path the failure lands on (written here, never parsed from the text). */
  path?: string;
  /** W3-7 §8.1 ②: the cause a Node error carried. */
  kind?: FailureKind;
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

/** Pure: the sub-case is the Issue's control (its checks must PASS after the trigger, SKILL R7). */
export const isControl = (p: { audit?: { sub: string } }) => p.audit?.sub === 'control';

/** W3-1 §7.4 — before the trigger (baseline state): the baseline holds, and every phenomenon check reads
 *  「不通过」 — a check that already passes before anything happened passes whatever happens (no
 *  discrimination). Throws WarmupError (计划不可执行). */
export async function proveChecksCanFail(c: RunCtx, steps: WarmupStep[], observe: typeof observeCheck = observeCheck, baseline: typeof readBaseline = readBaseline): Promise<void> {
  const fail = async (st: WarmupStep) => {
    steps.push(st);
    c.log(`warm-up ${st.action}: FAILED (${st.observed})`);
    await writeFile(join(c.o.runDir, 'warmup.json'), JSON.stringify(steps, null, 2));
    await writeFile(join(c.o.runDir, 'warmup-failed-baseline.png'), await c.sess.d.screenshot()).catch(() => {});
    throw new WarmupError(st, steps);
  };
  if (c.plan.baseline.length) {
    const b = await baseline(c, 0);
    const st: WarmupStep = { step: 0, action: '基线', expected: '基线成立', observed: b ? `${b.at}: ${b.detail}` : 'baseline holds', pass: !b, ms: 0, tier: '①', ...(b ? { path: b.at } : {}) };
    if (b) await fail(st);
    steps.push(st);
  }
  if (isControl(c.plan)) return;
  for (const [i, a] of c.plan.actions.entries()) {
    if (a.expect?.role !== 'phenomenon') continue;
    const t0 = Date.now();
    const r = await observe(c, a.expect.check).catch(() => undefined);
    const st: WarmupStep = { step: 0, action: `反证 actions[${i}]`, expected: '触发前现象检查判「不通过」（检查有区分度）', observed: r ? r.detail : '读不出', pass: r?.pass === false, ms: Date.now() - t0, tier: r?.tier, path: `actions[${i}].expect` };
    if (r?.pass === true) await fail({ ...st, observed: `检查无区分度：触发前就判「通过」— ${r.detail}` });
    // Unreadable before the trigger (e.g. its anchor message is sent inside the round) cannot pass either: fine.
    // Only a check that already passes proves nothing (§7.4).
    steps.push(r?.pass === false ? st : { ...st, pass: null, observed: `触发前读不到（${r?.detail ?? `${a.expect.check.kind} cannot be read on ${c.plan.surface}`}），不会判「通过」` });
  }
}

export async function runWarmup(c: RunCtx): Promise<WarmupStep[]> {
  const { d, inner, profile } = c.sess;
  const android = inner instanceof AndroidDriver ? inner : undefined;
  const web = c.sess.web?.page ? c.sess.web : undefined;
  const steps: WarmupStep[] = [];
  d.round = 0;
  c.log(`warm-up: ${c.plan.actions.length} steps with per-step verification`);
  await proveChecksCanFail(c, steps);
  for (const [i, a] of c.plan.actions.entries()) {
    const t0 = Date.now();
    // An action carrying the phenomenon check is observed by that check: "nothing happens" may be exactly the
    // Issue (2063: long-press, no menu, screen Δ0) — the generic effect gate must not call the plan broken.
    const eff = a.expect?.role === 'phenomenon' ? undefined : expectedEffect(a);
    const pt = tapPoint(c, a);
    let nodes: UiNode[] = [];
    if (android && pt) nodes = await dumpTree(android.o.udid, android.o.packageName, 2);
    const fp = pt ? nodeAt(nodes, pt.x, pt.y) : undefined;
    const st: WarmupStep = { step: i + 1, action: actionLabel(a), expected: eff ? describeEffect(eff) : '（不核验）', observed: '', pass: null, ms: 0, point: pt, fingerprint: fp ? { text: fp.text, desc: fp.desc, cls: fp.cls } : undefined };
    const attempt = async () => {
      const url0 = web?.page?.url() ?? '';
      const before = eff?.kind === 'change' || eff?.kind === 'navigate' || eff?.kind === 'soft-change' || (eff?.kind === 'focus' && android) ? decodePng(await d.screenshot()) : undefined;
      d.label = `warmup:${actionLabel(a)}`;
      c.res.at = `actions[${i}]`;
      try {
        await c.exec(a);
      } catch (e) {
        // The step's input did not land / the round precondition does not hold: the step failed.
        if (e instanceof RoundDrift) return { pass: false as boolean | null, observed: e.message, tier: '①' as string | undefined, kind: e.kind };
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
    let r: { pass: boolean | null; observed: string; tier?: string; kind?: FailureKind; path?: string } = await attempt();
    // W3-1: the post-condition read right after the action (before any other observation of the step).
    const readX = async () => {
      const x = await readExpect(c, a, `actions[${i}]`, 0);
      if (!x) return;
      st.expect = { role: x.role, pass: x.pass, detail: x.detail };
      if (x.role === 'precondition' && x.pass !== true) r = { pass: false, observed: `expect（前置）不成立：${x.detail}`, tier: '①', path: `actions[${i}].expect` };
      else if (x.role === 'phenomenon' && isControl(c.plan) && x.pass !== true) r = { pass: false, observed: `对照组的现象检查不通过（正常时它应通过）：${x.detail}`, tier: '①', path: `actions[${i}].expect` };
    };
    if (r.pass !== false) await readX();
    if (r.pass === false) {
      // One redo; a fixed element is first located again on the live screen (its cached point may be stale).
      if (a.element && !a.element.startsWith('target.') && (await c.sess.profile.resolver?.refresh(a.element).catch(() => false))) st.healed = `重新定位 ${a.element}`;
      st.redo = true;
      r = await attempt();
      if (r.pass !== false) await readX();
    }
    st.pass = r.pass;
    st.observed = r.observed;
    st.tier = r.tier;
    if (r.pass === false) {
      st.path = r.path ?? `actions[${i}]`;
      if (r.kind) st.kind = r.kind;
    }
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
  // The restore steps, each verified (W3-1 §6.4): an unverified restore makes the plan not executable.
  const rf = await restore(c, 0);
  c.res.at = undefined;
  if (rf) {
    const st: WarmupStep = { step: steps.length + 1, action: '复位（afterCheck）', expected: '复位后的 expect 成立', observed: rf, pass: false, ms: 0, tier: '①', path: rf.match(/^afterCheck\[\d+\]/)?.[0] ?? 'afterCheck' };
    steps.push(st);
    await writeFile(join(c.o.runDir, 'warmup.json'), JSON.stringify(steps, null, 2));
    await writeFile(join(c.o.runDir, 'warmup-failed-restore.png'), await d.screenshot()).catch(() => {});
    throw new WarmupError(st, steps);
  }
  await writeFile(join(c.o.runDir, 'warmup.json'), JSON.stringify(c.res.warmup, null, 2));
  c.log(`warm-up passed (${steps.filter((s) => s.pass).length}/${steps.filter((s) => s.pass !== null).length} verified steps)`);
  return steps;
}
