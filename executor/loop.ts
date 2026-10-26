// The loop: plan actions by coordinates, ≤ 1 s apart; the per-step anomaly gate is the driver's event
// stream only (no screenshot, no hierarchy read, no vision per step). Round end: checkpoint, drift
// handling, evidence review of check-based hits, afterCheck, verdict rule.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, dHash } from '../core/image';
import { HARD_ANOMALIES, sleep } from '../drivers/types';
import { incidentKind } from '../incident/bundle';
import { type EvidenceVerdict, reviewIncident } from '../incident/evidence-review';
import type { NormalizedIssue } from '../issue/parse';
import { HARD_LIMITS } from '../platform/schema/test-plan';
import { actionLabel, idleMs } from './actions';
import { Checkpoint, needsScreenshot } from './checkpoint';
import type { RunCtx } from './context';
import { recordIncident } from './incident-hook';
import { onChat, redoSetup } from './prepare';
import { applyIntervals } from './stats';
import { VerdictTracker } from './verdict';

const WATCHDOG_MS = 20_000;

export interface LoopOptions {
  /** The Issue (or contract phenomenon) check-based hits are reviewed against; none = no review. */
  reviewIssue?: NormalizedIssue;
  /** suspected-misuse: result of the correct path. */
  correctPathOk?: boolean;
}

export async function runLoop(c: RunCtx, lo: LoopOptions = {}): Promise<void> {
  const { plan, stats, res, log } = c;
  const { d, web } = c.sess;
  const maxSteps = Math.min(c.o.maxSteps ?? plan.limits.maxSteps, HARD_LIMITS.maxSteps);
  const maxMs = Math.min(c.o.maxMinutes ?? plan.limits.maxMinutes, HARD_LIMITS.maxMinutes) * 60_000;
  const tracker = new VerdictTracker(plan.verdictRule);
  const checkpoint = new Checkpoint(c);
  let dismissedRun = 0;
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
    for (const a of plan.actions) {
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
      const ok = await Promise.race([c.exec(a).then(() => true), sleep(budget).then(() => false)]);
      if (!ok) {
        stop = `看门狗：第 ${stats.steps} 步 ${d.label} 超过 ${budget / 1000}s`;
        res.incidents.push(await recordIncident(c, 'watchdog', stop, round));
        break;
      }
      for (const x of d.drainAnomalies()) {
        stats.anomalyGateTriggers++;
        if (x.suspect) stats.suspectSignals++;
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
      if (roundHitReason) break;
    }
    if (stop && !roundHitReason && stats.steps === stepsBefore) break;
    // ---- round-end checkpoint
    let png: Buffer | undefined;
    if (!roundHitReason && needsScreenshot(plan.checks)) {
      png = await d.screenshot();
      stats.checkpointScreenshots++;
    }
    const results = await checkpoint.evaluate(png);
    let failed = results.find((r) => r.pass === false);
    const hardHit = !!roundHitReason;
    if (failed && !hardHit && png && !(await onChat(c, png))) {
      // Operation drift (we are not where the plan thinks): not a finding. Re-enter and continue.
      stats.drifts++;
      await writeFile(join(c.o.runDir, `drift-round-${round}.png`), png);
      log(`round ${round}: operation drift (chat page not on screen) — re-entering, not counted`);
      failed = undefined;
      results.length = 0;
      await redoSetup(c);
      if (stats.drifts > 10) stop = '操作偏离过多（>10 次），停止';
    }
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
    if (failed && !hardHit && res.incidents.length < 5 + (res.dismissed?.length ?? 0)) {
      const dir = await recordIncident(c, failed.check.kind === 'visual-region' ? 'check-failed' : 'visual-anomaly', roundHitReason, round);
      res.incidents.push(dir);
      // The check only compares pixels: before the round counts, the recorded evidence must show what
      // the Issue describes. A rejected hit is kept (bundle + review) but does not count.
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
    if (roundHitReason) res.hits.push({ round, step: stats.steps, at: new Date().toISOString(), reason: roundHitReason, review: review?.verdict, reviewNote: review?.note });
    res.roundLog.push({ round, step: stats.steps, results: results.map((r) => ({ kind: r.check.kind, pass: r.pass, detail: r.detail })) });
    if (res.roundLog.length > 200) res.roundLog.splice(0, 50);
    stats.rounds = round;
    if (!stop && !hardHit)
      for (const a of plan.afterCheck) {
        d.label = `after:${actionLabel(a)}`;
        await c.exec(a);
      }
    if (tracker.record(!!roundHitReason)) stop = `判定规则满足（${'anyHit' in plan.verdictRule ? '命中 1 次' : '连续 3 次命中'}）`;
    if (round % 20 === 0) log(`round ${round}, steps ${stats.steps}, hits ${tracker.hits}, ${Math.round((Date.now() - c.t0) / 1000)}s`);
    if (web) await c.wfr!.rotate(web.context!);
  }
  applyIntervals(stats, d.ops, plan.limits.maxIntervalMs);
  res.conclusion = tracker.conclusion(plan.category);
  if (stop.startsWith('自动检查连续') && !tracker.reproduced()) res.conclusion = '执行失败';
  if (lo.correctPathOk !== undefined) res.conclusion = !lo.correctPathOk ? '转为 bug' : tracker.reproduced() ? '疑似误操作' : '未复现（上限内未出现）';
  res.conclusionDetail = `停止原因：${stop}；共 ${stats.rounds} 轮 ${stats.steps} 步，命中 ${tracker.hits} 次${tracker.hits ? `（第 ${tracker.hitRounds.slice(0, 10).join(', ')} 轮）` : ''}${res.dismissed?.length ? `；证据复核排除误报 ${res.dismissed.length} 次` : ''}`;
}
