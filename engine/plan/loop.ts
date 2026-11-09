// The loop: plan actions by coordinates, ≤ 1 s apart; the per-step anomaly gate is the driver's event
// stream only (no screenshot, no hierarchy read, no vision per step; a plan's `require` step is the one ①
// read of a round's own precondition). Round end: checkpoint, drift handling, evidence review of check-based
// hits, afterCheck, verdict rule. W2-2 §3.1: a round is a valid attempt only when its precondition held and
// nothing drifted; drift rounds are counted apart and never decide the verdict.
// W3-1 §6: the round's baseline is read before its first action; an action with `expect` is observed right
// after it (phenomenon: failing = the hit; precondition: failing = drift); the restore steps' expects are read
// before the round is counted (failing = drift); plans with limits.untilBudget run the whole budget.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, dHash } from '../../core/image';
import { HARD_ANOMALIES, RoundDrift, sleep } from '../../drivers/types';
import { incidentKind } from '../recorder/bundle';
import { type EvidenceVerdict, reviewIncident } from '../recorder/evidence-review';
import type { NormalizedIssue } from '../../issue/parse';
import { HARD_LIMITS } from '../../platform/schema/test-plan';
import { actionLabel, idleMs } from './actions';
import { Checkpoint, needsScreenshot } from './checkpoint';
import type { RunCtx } from './context';
import { recordIncident } from '../recorder/incident-hook';
import { recoverAfterDrift } from './isolation';
import { composerText } from '../observe';
import { onChat } from './prepare';
import { applyIntervals, attemptsOf, attemptsText } from '../stats';
import { VerdictTracker } from '../verdict';
import { detect, DETECT_EXPECTED, newDetectState } from '../detect';
import { snapshot } from '../snapshot';
import { visionAsk } from '../../core/model/midscene';
import { readBaseline, readExpect, SAMPLE_EVERY, sampleScreen } from './expect';

/** W3-1 default: a version whose drift rate exceeds this is "触发未稳定生效" and goes to revision. */
export const DRIFT_THRESHOLD = 0.3;

const WATCHDOG_MS = 20_000;

export interface LoopOptions {
  /** The Issue (or contract phenomenon) check-based hits are reviewed against; none = no review. */
  reviewIssue?: NormalizedIssue;
  /** suspected-misuse: result of the correct path. */
  correctPathOk?: boolean;
}

/** Incidental findings (W2-5 §6): the deterministic detectors run at the round end every this many rounds. */
export const INCIDENTAL_EVERY = 10;
/** At most this many incidental findings per run (bundles + reviews cost time). */
const MAX_INCIDENTAL = 5;

export async function runLoop(c: RunCtx, lo: LoopOptions = {}): Promise<void> {
  const { plan, stats, res, log } = c;
  res.incidental ??= [];
  const dst = newDetectState();
  const seenHits = new Set<string>();
  // Round end only (the round's steps stay coordinate-only, D2): a snapshot of its own, judged by the
  // deterministic detectors; a hit is reviewed against the detector's description and never touches the verdict.
  const incidental = async (round: number) => {
    if (res.incidental!.length >= MAX_INCIDENTAL) return;
    const snap = await snapshot(c.sess.inner, { keepPng: true, skipStable: true, texts: true }).catch(() => undefined);
    if (!snap?.png) return;
    stats.incidentalSnapshots = (stats.incidentalSnapshots ?? 0) + 1;
    const img = (() => {
      try {
        return decodePng(snap.png!);
      } catch {
        return undefined;
      }
    })();
    for (const h of detect({ at: Date.now(), img, nodes: snap.nodes, texts: snap.texts, width: snap.width || img?.width || 0, height: snap.height || img?.height || 0 }, dst)) {
      const key = `${h.kind}:${h.text ?? ''}`;
      if (seenHits.has(key) || res.incidental!.length >= MAX_INCIDENTAL) continue;
      seenHits.add(key);
      const dir = await recordIncident(c, 'visual-anomaly', `incidental ${h.kind}: ${h.description}`, round);
      const rv = await reviewIncident(dir, { id: plan.issueRef, summary: plan.title, expected: DETECT_EXPECTED[h.kind], actual: h.description } as NormalizedIssue, { subcase: plan.title, log }).catch(() => undefined);
      res.incidental!.push({ n: res.incidental!.length + 1, round, step: stats.steps, kind: h.kind, description: h.description, incident: dir, review: rv?.verdict, counted: rv?.verdict === 'consistent' });
      log(`round ${round}: incidental finding ${h.kind} — ${h.description} (review ${rv?.verdict ?? 'unverified'}; not part of the verdict)`);
    }
  };
  const { d, web } = c.sess;
  const maxSteps = Math.min(c.o.maxSteps ?? plan.limits.maxSteps, HARD_LIMITS.maxSteps);
  const maxMs = Math.min(c.o.maxMinutes ?? plan.limits.maxMinutes, HARD_LIMITS.maxMinutes) * 60_000;
  const maxRounds = c.o.maxRounds ?? plan.limits.maxRounds;
  const tracker = new VerdictTracker(plan.verdictRule);
  const checkpoint = new Checkpoint(c);
  let dismissedRun = 0;
  let driftRounds = 0;
  let stop = '';
  for (let round = 1; !stop; round++) {
    d.round = round;
    if (plan.launch === 'each-iteration' && round > 1) {
      d.label = 'relaunch';
      await d.launch();
      stats.launches++;
    }
    const stepsBefore = stats.steps;
    let roundHitReason = '';
    let drift = '';
    // W3-1: the phenomenon check of an action that failed (the hit), observed right after that action.
    let expectHit: { at: string; detail: string; check: NonNullable<(typeof plan.actions)[number]['expect']>['check']; png?: Buffer } | undefined;
    if (plan.baseline.length && !c.o.hooks?.shouldStop()) {
      d.label = 'baseline';
      const b = await readBaseline(c, round);
      if (b) drift = `baseline not met (${b.at}): ${b.detail}`;
    }
    for (const [ai, a] of plan.actions.entries()) {
      if (drift) break;
      // W2-3 §4.3 L2: a cancel request stops at a step boundary; the run then finishes normally (teardown).
      if (c.o.hooks?.shouldStop()) {
        stop = '已取消（取消请求）';
        res.cancelled = true;
        break;
      }
      if (stats.steps >= maxSteps) {
        stop = `步数上限 ${maxSteps}`;
        break;
      }
      if (Date.now() - c.t0 > maxMs) {
        stop = `时长上限 ${maxMs / 60_000} 分钟`;
        break;
      }
      stats.steps++;
      d.step = stats.steps;
      d.label = actionLabel(a);
      const budget = WATCHDOG_MS + (a.type === 'idle' ? idleMs(a) : 0) + (a.type === 'killApp' || a.type === 'reload' ? 10_000 : 0);
      let err: unknown;
      // W3-1 §6.1: an action with `expect` is read inside its own delay — run it without the pause, read,
      // then wait out what is left of delayAfterMs (the next input still starts ≤ 1 s later when the read is fast).
      const tAct = Date.now();
      const ok = await Promise.race([
        c.exec(a.expect ? { ...a, delayAfterMs: 0 } : a).then(
          () => true,
          (e) => {
            err = e;
            return true;
          },
        ),
        sleep(budget).then(() => false),
      ]);
      if (!ok) {
        stop = `看门狗：第 ${stats.steps} 步 ${d.label} 超过 ${budget / 1000}s`;
        res.incidents.push(await recordIncident(c, 'watchdog', stop, round));
        break;
      }
      // A step whose input did not land / a round precondition that does not hold: the round is not an attempt.
      if (err instanceof RoundDrift) drift = err.message;
      else if (err) throw err;
      // W3-1: the action's post-condition, read now (① only, within the action interval).
      if (!err && a.expect) {
        const at = `actions[${ai}]`;
        const r = await readExpect(c, a, at, round);
        if (r && r.pass !== true) {
          if (r.role === 'precondition' || r.pass === null) drift = `expect ${at} (${r.role}) ${r.pass === null ? 'unreadable' : 'not met'}: ${r.detail}`;
          else expectHit = { at, detail: r.detail, check: a.expect.check, png: await d.screenshot().catch(() => undefined) };
        }
        if (!expectHit && !drift) await sleep(Math.max(0, Math.min(a.delayAfterMs, 1000) - (Date.now() - tAct)));
      }
      for (const x of d.drainAnomalies()) {
        stats.anomalyGateTriggers++;
        if (x.suspect) {
          stats.suspectSignals++;
          // The logcat line itself (revision material), not only the count.
          if ((res.suspects ??= []).length < 100) res.suspects.push({ round, step: stats.steps, kind: x.kind, detail: x.detail.slice(0, 500) });
        }
        if (HARD_ANOMALIES.includes(x.kind) && !roundHitReason) {
          roundHitReason = `${x.kind}: ${x.detail.slice(0, 200)}`;
          log(`HIT step ${stats.steps}: ${roundHitReason}`);
          res.incidents.push(await recordIncident(c, incidentKind(x.kind), x.detail, round));
          if (x.kind === 'app-exit' || x.kind === 'crash' || x.kind === 'anr') {
            // The app is gone: one relaunch, then continue (an Issue still launches once otherwise).
            await sleep(1500);
            await d.launch();
            stats.launches++;
          }
        }
      }
      if (roundHitReason || drift || expectHit) break;
    }
    if (stop && !roundHitReason && stats.steps === stepsBefore) break;
    const hardHit = !!roundHitReason;
    if (hardHit) drift = ''; // a crash is a finding whatever the round's precondition
    // ---- round-end checkpoint (not on a round that already drifted)
    let png: Buffer | undefined;
    let results: Awaited<ReturnType<Checkpoint['evaluate']>> = [];
    let failed: (typeof results)[number] | undefined;
    if (!drift && expectHit && !hardHit) {
      // The phenomenon was observed at its own step: that observation is the round's result (no round-end read).
      png = expectHit.png ?? (await d.screenshot());
      stats.checkpointScreenshots++;
      failed = { check: expectHit.check, pass: false, detail: `${expectHit.at}: ${expectHit.detail}` };
      results = [failed];
      if (!(await onChat(c, png))) drift = 'chat page not on screen';
    } else if (!drift) {
      if (!hardHit && needsScreenshot(plan.checks)) {
        png = await d.screenshot();
        stats.checkpointScreenshots++;
      }
      results = await checkpoint.evaluate(png);
      // A check that could not apply to this round (e.g. no message of this round on screen) = drift.
      const nd = results.find((r) => r.drift && r.pass !== true);
      if (nd && !hardHit) drift = nd.drift!;
      failed = results.find((r) => r.pass === false);
      // Deterministic checks need no screenshot; a failed one still gets one (drift check, evidence frames).
      if (failed && !hardHit && !png) {
        png = await d.screenshot();
        stats.checkpointScreenshots++;
      }
      // The check's own precondition (e.g. "@" really in the composer): not met = the input did not land.
      if (failed && !hardHit && !drift && failed.check.requires?.composerHas) {
        const want = failed.check.requires.composerHas;
        if (plan.surface === 'android-web') {
          // The phone browser's tree is stale after in-page navigation (W2-5 §8.2): ask the screen (round end,
          // after a failed check — where D5 allows the vision model).
          const has = await visionAsk(c.sess.inner as any, `The message input box at the bottom of the chat contains the text "${want}"`, 'checkpoint').catch(() => null);
          if (has === false) drift = `check precondition not met: the composer does not show "${want}" (vision)`;
        } else {
          const t = await composerText(c.sess.inner);
          if (t !== null && !t.includes(want)) drift = `check precondition not met: composer is "${t.slice(0, 40)}", not containing "${want}"`;
        }
      }
      if (failed && !hardHit && !drift && png && !(await onChat(c, png))) drift = 'chat page not on screen';
    }
    if (drift && !hardHit) {
      // Operation drift (we are not where the plan thinks / the input did not land): not an attempt.
      driftRounds++;
      stats.drifts++;
      png ??= await d.screenshot().catch(() => undefined);
      if (png) await writeFile(join(c.o.runDir, `drift-round-${round}.png`), png);
      log(`round ${round}: operation drift (${drift}) — not counted`);
      res.roundLog.push({ round, step: stats.steps, results: [{ kind: 'drift', pass: null, detail: drift }] });
      failed = undefined;
      await recoverAfterDrift(c);
      if (stats.drifts > 10) stop = '操作偏离过多（>10 次），停止';
    } else {
      if (failed && !roundHitReason) {
        roundHitReason = `check failed: ${failed.check.expect} — ${failed.detail}`;
        log(`HIT round ${round} step ${stats.steps}: ${roundHitReason}`);
      }
      if (png) {
        c.frames.push({ round, step: stats.steps, at: Date.now(), hash: dHash(decodePng(png)), png });
        if (c.frames.length > 60) c.frames.shift();
        for (const f of c.frames.slice(0, -10)) f.png = undefined;
      }
      let review: { verdict: EvidenceVerdict; note: string } | undefined;
      if (failed && !hardHit && res.incidents.length < (plan.limits.untilBudget ? (plan.limits.maxRounds ?? 30) : 5) + (res.dismissed?.length ?? 0)) {
        const dir = await recordIncident(c, failed.check.kind === 'visual-region' ? 'check-failed' : 'visual-anomaly', roundHitReason, round);
        res.incidents.push(dir);
        // The check only compares pixels / text: before the round counts, the recorded evidence must show
        // what the Issue describes. A rejected hit is kept (bundle + review) but does not count.
        if (lo.reviewIssue) {
          const rv = await reviewIncident(dir, lo.reviewIssue, { subcase: plan.title, log });
          stats.evidenceReviews = (stats.evidenceReviews ?? 0) + 1;
          review = { verdict: rv.verdict, note: rv.observed || rv.reason };
          if (rv.verdict === 'inconsistent') {
            (res.dismissed ??= []).push({ round, step: stats.steps, reason: roundHitReason, observed: review.note, incident: dir });
            log(`round ${round}: evidence review — frames do not show the Issue's phenomenon; hit dismissed (${review.note.slice(0, 160)})`);
            roundHitReason = '';
            dismissedRun++;
            if (dismissedRun >= 3) stop = '自动检查连续 3 次误报（证据复核不符），检查需重新标定';
          }
        }
      }
      if (roundHitReason) dismissedRun = 0;
      // Restore before the round is counted: a restore whose expect does not hold leaves the next round on a
      // wrong state — a round without a hit then counts as drift (W3-1 §6.4).
      let resetFail = '';
      if (!stop && !hardHit) resetFail = await restore(c, round);
      if (resetFail && !roundHitReason) {
        driftRounds++;
        stats.drifts++;
        log(`round ${round}: restore not verified (${resetFail}) — not counted`);
        res.roundLog.push({ round, step: stats.steps, results: [{ kind: 'drift', pass: null, detail: `restore: ${resetFail}` }] });
        await recoverAfterDrift(c);
        if (stats.drifts > 10) stop = '操作偏离过多（>10 次），停止';
      } else {
        if (resetFail) await recoverAfterDrift(c);
        if (roundHitReason) res.hits.push({ round, step: stats.steps, at: new Date().toISOString(), reason: roundHitReason, review: review?.verdict, reviewNote: review?.note });
        res.roundLog.push({ round, step: stats.steps, results: results.map((r) => ({ kind: r.check.kind, pass: r.pass, detail: r.detail })) });
        // W3-1: the reproduction rate needs the whole budget — no stop on a hit.
        if (tracker.record(!!roundHitReason, round) && !plan.limits.untilBudget) stop = '判定规则满足（命中 1 次）';
      }
    }
    if (res.roundLog.length > 200) res.roundLog.splice(0, 50);
    if (!hardHit && (round === 1 || round % INCIDENTAL_EVERY === 0)) await incidental(round);
    if (round % SAMPLE_EVERY === 0) await sampleScreen(c, round).catch(() => {});
    stats.rounds = round;
    if (!stop && maxRounds && tracker.rounds >= maxRounds) stop = `有效尝试上限 ${maxRounds} 轮`;
    if (round % 20 === 0) log(`round ${round}, steps ${stats.steps}, hits ${tracker.hits}, ${Math.round((Date.now() - c.t0) / 1000)}s`);
    if (web) await c.wfr!.rotate(web.context!);
  }
  applyIntervals(stats, d.ops, plan.limits.maxIntervalMs);
  res.attempts = attemptsOf(tracker.rounds, driftRounds, tracker.hits);
  const driftRate = tracker.rounds + driftRounds ? driftRounds / (tracker.rounds + driftRounds) : 0;
  res.executability = { validated: true, warmup: res.warmup ? 'passed' : 'not-run', driftRate: Math.round(driftRate * 1000) / 1000, unstable: driftRate > DRIFT_THRESHOLD };
  res.conclusion = tracker.conclusion();
  if (stop.startsWith('自动检查连续') && !tracker.reproduced()) res.conclusion = '执行失败';
  // No valid attempt at all: nothing can be said about the product.
  if (!tracker.rounds && !tracker.reproduced()) res.conclusion = '执行失败';
  if (lo.correctPathOk !== undefined && res.conclusion !== '执行失败') res.conclusion = !lo.correctPathOk ? '转为 bug' : tracker.reproduced() ? '疑似误操作' : '未复现';
  res.conclusionDetail = `${attemptsText(res.attempts)}${res.executability.unstable ? `；偏离率 ${Math.round(driftRate * 100)}% 超过 ${DRIFT_THRESHOLD * 100}%：触发未稳定生效` : ''}；停止原因：${stop}；共 ${stats.rounds} 轮 ${stats.steps} 步${tracker.hits ? `，命中轮次 ${tracker.hitRounds.slice(0, 10).join(', ')}` : ''}${res.dismissed?.length ? `；证据复核排除误报 ${res.dismissed.length} 次` : ''}`;
  if (res.conclusion === '执行失败' && !res.error) res.error = !tracker.rounds ? `0 次有效尝试（${driftRounds} 轮全部偏离：${res.roundLog.at(-1)?.results[0]?.detail ?? stop}）` : stop;
}

/** Run the plan's restore steps (afterCheck); each step with `expect` is read right after it (a precondition).
 *  Returns why the restore is not verified ('' = verified / nothing to verify). */
export async function restore(c: RunCtx, round: number): Promise<string> {
  const { d } = c.sess;
  for (const [i, a] of c.plan.afterCheck.entries()) {
    d.label = `after:${actionLabel(a)}`;
    await c.exec(a);
    if (!a.expect) continue;
    const r = await readExpect(c, a, `afterCheck[${i}]`, round);
    if (r && r.pass !== true) return `afterCheck[${i}] ${r.pass === null ? 'unreadable' : 'not met'}: ${r.detail}`;
  }
  return '';
}
