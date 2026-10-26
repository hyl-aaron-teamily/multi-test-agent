// Executor (milestone 5 §C): black-box, coordinate-driven.
//   prepare once : lease account (+device) → launch once → SKILL freshness check → model picks dynamic
//                  targets → frozen coordinates → setup
//   loop         : plan actions by coordinates, ≤1 s apart; no screenshot / extra adb per step — the
//                  anomaly gate is the driver's event stream (logcat / page events)
//   round end    : checkpoint screenshot only when a visual check exists; region hash vs reference;
//                  vision model only on mismatch (or explicit ai checks)
//   verdict      : intermittent → 1 hit; always → 3 consecutive hits; limits / watchdog stop the run
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decodePng, dHash, hamming } from '../core/image';
import { AndroidDriver } from '../drivers/android';
import { type Anomaly, type Driver, HARD_ANOMALIES, lifecycle, type Point, sleep } from '../drivers/types';
import { WebDriver } from '../drivers/web';
import { AndroidFlightRecorder } from '../incident/android-recorder';
import { type IncidentKind, incidentDir, incidentKind, type ReplayFile, type RoundFrame, writeIncident } from '../incident/bundle';
import { type CoordOp, RecordingDriver } from '../incident/recording-driver';
import { type EvidenceVerdict, reviewIncident } from '../incident/evidence-review';
import { WebFlightRecorder } from '../incident/web-recorder';
import { modelCalls, visionConfigured } from '../core/model/llm';
import { type NormalizedIssue, parseIssue } from '../issue/parse';
import type { AccountPool, Lease } from '../platform/accounts/account-pool';
import { ensureWebSession, type PlaywrightSurface } from '../platform/accounts/sessions';
import { mobileLayout, onAndroid, onPlaywright } from '../platform/accounts/types';
import { ensureUiLogin } from '../platform/accounts/ui-login';
import { profileKey, TEAMILY_PACKAGE } from '../drivers/factory';
import { closeSession, enterApp, openSession, type Session, staleShotPath } from './session';
import type { DevicePool } from '../platform/device-pool';
import { HARD_LIMITS, LIFECYCLE_OPS, MAX_IDLE_MS, type PlannedAction, type TestPlan } from '../platform/schema/test-plan';
import { loadProfile, pointOf, type Profile, SkillStaleError } from '../skills/profile';
import { type NodeContext, runNode } from '../skills/teamily/nodes';
import { assertSkillFresh, type CheckResult, evaluateAi, evaluateVisual, regionMatch, visionAsker, waitForRegion } from './checks';
import { type FrozenTarget, pickTargets, quotedOriginalVisible, visionLocator } from './targets';
import { type Conclusion, featureConclusion, VerdictTracker } from './verdict';

export interface RunOptions {
  plan: TestPlan;
  runDir: string;
  pool: AccountPool;
  devices?: DevicePool;
  udid?: string;
  headed?: boolean;
  maxSteps?: number;
  maxMinutes?: number;
  log?: (s: string) => void;
  taskId?: string;
  /** Check-based hits are reviewed against the Issue on their recorded evidence before they count
   *  (default: on when the Issue file exists and a vision model is configured). */
  evidenceReview?: boolean;
}

export interface Stats {
  steps: number;
  rounds: number;
  durationSec: number;
  avgIntervalMs: number;
  maxIntervalMs: number;
  /** Intervals above the plan's 1 s cap (with the per-op time of the device included). */
  intervalsOverCap: number;
  anomalyGateTriggers: number;
  suspectSignals: number;
  checkpointScreenshots: number;
  visionCalls: number;
  textModelCalls: number;
  launches: number;
  /** Rounds discarded because the screen was not where the plan expected (re-entered). */
  drifts: number;
  /** Check-based hits whose evidence was reviewed by the vision model. */
  evidenceReviews?: number;
}

export interface RunResult {
  planId: string;
  issue: string;
  title: string;
  category: TestPlan['category'];
  surface: TestPlan['surface'];
  substitution?: TestPlan['substitution'];
  env: TestPlan['env'];
  account?: string;
  device?: string;
  conclusion: Conclusion;
  conclusionDetail: string;
  startedAt: string;
  finishedAt: string;
  stats: Stats;
  hits: { round: number; step: number; at: string; reason: string; review?: EvidenceVerdict; reviewNote?: string }[];
  /** Check-based hits the evidence review rejected (frames do not show the Issue's phenomenon): not counted. */
  dismissed?: { round: number; step: number; reason: string; observed: string; incident: string }[];
  incidents: string[];
  targets: FrozenTarget[];
  acceptance?: { id: string; text: string; pass: boolean | null; detail: string; evidence?: string }[];
  roundLog: { round: number; step: number; results: { kind: string; pass: boolean | null; detail: string }[] }[];
  error?: string;
}

const HARD = HARD_ANOMALIES;
const WATCHDOG_MS = 20_000;
/** Baseline check: fraction of the reference bubble's marks that may be missing. Diagnostic override
 *  AUTOTEST_BASELINE_TOLERANCE (e.g. 0.05 restores the strict pre-fix threshold that raised 1329's false hits). */
const BASELINE_TOLERANCE = Number(process.env.AUTOTEST_BASELINE_TOLERANCE ?? 0.35);

export async function runPlan(o: RunOptions): Promise<RunResult> {
  const plan = o.plan;
  const log = o.log ?? ((s) => console.log(`[run] ${s}`));
  const maxSteps = Math.min(o.maxSteps ?? plan.limits.maxSteps, HARD_LIMITS.maxSteps);
  const maxMs = Math.min(o.maxMinutes ?? plan.limits.maxMinutes, HARD_LIMITS.maxMinutes) * 60_000;
  await mkdir(o.runDir, { recursive: true });
  const t0 = Date.now();
  const stats: Stats = { steps: 0, rounds: 0, durationSec: 0, avgIntervalMs: 0, maxIntervalMs: 0, intervalsOverCap: 0, anomalyGateTriggers: 0, suspectSignals: 0, checkpointScreenshots: 0, visionCalls: 0, textModelCalls: 0, launches: 0, drifts: 0 };
  const vision0 = modelCalls.vision;
  const text0 = modelCalls.text;
  const res: RunResult = {
    planId: plan.id,
    issue: plan.issueRef,
    title: plan.title,
    category: plan.category,
    surface: plan.surface,
    substitution: plan.substitution,
    env: plan.env,
    conclusion: '执行失败',
    conclusionDetail: '',
    startedAt: new Date(t0).toISOString(),
    finishedAt: '',
    stats,
    hits: [],
    incidents: [],
    targets: [],
    roundLog: [],
  };

  // ---- lease: account + slot of an endpoint (a phone for Android surfaces, this computer otherwise)
  const taskId = o.taskId ?? `run-${plan.id}-${t0}`;
  let lease: Lease | null = null;
  for (let i = 0; i < 30 && !lease; i++) {
    lease = o.pool.lease(taskId, { env: plan.env, surface: plan.surface, accountId: plan.account, devices: o.devices, device: onAndroid(plan.surface) ? o.udid : undefined });
    if (!lease) await sleep(2000);
  }
  if (!lease) {
    res.error = `no free ${plan.env} account${o.devices ? ' / endpoint slot' : ''} for ${plan.surface}`;
    return finish(res, t0, stats, vision0, text0);
  }
  const account = lease.accounts[0];
  res.account = account.id;
  const udid = lease.device?.kind === 'android' ? lease.device.udid : (o.udid ?? (onAndroid(plan.surface) ? account.boundDevice : undefined));
  res.device = onAndroid(plan.surface) ? udid : undefined;

  let sess: Session | undefined;
  let afr: AndroidFlightRecorder | undefined;
  let wfr: WebFlightRecorder | undefined;
  const flightDir = join(o.runDir, '.flight');
  try {
    // ---- session: profile + driver + flight recorder, launch once, sign in, home list, SKILL check
    if (onPlaywright(plan.surface)) wfr = new WebFlightRecorder(flightDir);
    if (onAndroid(plan.surface) && udid) afr = new AndroidFlightRecorder(udid, loadProfile(profileKey(plan.surface, plan.env, udid))?.packageName ?? TEAMILY_PACKAGE, flightDir);
    sess = await openSession({ surface: plan.surface, env: plan.env, account: account.id, udid, pool: o.pool, headed: o.headed, onLog: afr?.onLog, onConsole: wfr?.onConsole, log });
    const { profile, inner, d, web } = sess;
    await afr?.start();
    await enterApp(sess, {
      afterLaunch: async () => {
        if (web) await wfr!.start(web.context!, web.page!);
      },
      // Phones: the bottom bar looks the same on every tab — make sure the chat tab is the one showing.
      chatTab: plan.setup.some((a) => a.node?.name === 'teamily.openConversation'),
      staleShot: staleShotPath(o.runDir),
    });
    stats.launches++;

    // ---- prepare: dynamic targets
    const ask = await visionAsker(web ?? (inner as any));
    const locate = await visionLocator(web ?? (inner as any));
    res.targets = await pickTargets(plan, inner, profile, log, locate, 'rows');
    const targets: Record<string, Point> = Object.fromEntries(res.targets.map((t) => [t.id, t.point]));
    const ctx: NodeContext = { driver: d, profile, targets, credentials: () => o.pool.backend.get(account.id) };
    const exec = (a: PlannedAction) => execAction(a, ctx, profile, targets);

    for (const a of plan.setup) {
      d.label = a.node?.name ?? a.element ?? a.type;
      await exec(a);
    }
    // Targets inside the opened conversation (message, reaction button) are decided after setup.
    for (const t of await pickTargets(plan, inner, profile, log, locate, 'inside', res.targets)) {
      res.targets.push(t);
      targets[t.id] = t.point;
    }
    const inChat = plan.setup.some((a) => a.node?.name === 'teamily.openConversation') && !!profile.refs.chat?.regions.composer;
    const composerCheck = { kind: 'visual-region' as const, page: 'chat', region: 'composer', expect: 'chat page open (composer visible)', want: 'present' as const };
    const onChat = async (png?: Buffer) => !inChat || (await evaluateVisual(d, profile, { ...composerCheck, onlyOnAnomaly: false }, undefined, png)).pass !== false;
    const redoSetup = async () => {
      // Left the app (a link opened a browser): bring the app back like a user would — launch it.
      if (inner instanceof AndroidDriver && !inner.foreground) {
        log('app not in foreground — relaunching it');
        await d.launch();
        stats.launches++;
        await sleep(2000);
      }
      for (let i = 0; i < 3 && mobileLayout(plan.surface); i++) {
        if (await onChat()) break;
        // Never back out of the home screen (that would leave the app).
        if ((await assertSkillFresh(d, profile).then(() => true, () => false)) === true) break;
        await sess!.adapter.leaveConversation(d, profile);
        await sleep(1200);
      }
      for (const a of plan.setup) {
        d.label = `re-setup:${a.node?.name ?? a.type}`;
        await exec(a);
      }
    };
    if (inChat && !(await onChat())) {
      log('not on the chat page after preparation — redoing setup');
      await redoSetup();
    }
    if (plan.prepare.length) {
      for (const a of plan.prepare) {
        d.label = `prepare:${a.node?.name ?? a.element ?? a.type}`;
        await exec(a);
      }
      if (plan.prepareCheck) {
        const pc = plan.prepareCheck.kind === 'ai' ? await evaluateAi(plan.prepareCheck, ask) : await evaluateVisual(d, profile, plan.prepareCheck, ask);
        await writeFile(join(o.runDir, 'prepare-check.png'), await d.screenshot());
        log(`precondition: ${pc.pass ? 'established' : 'NOT established'} — ${pc.detail}`);
        if (!pc.pass) throw new Error(`前置条件未建立（${plan.prepareCheck.expect}）— ${pc.detail}；见 prepare-check.png`);
      }
      for (const t of await pickTargets(plan, inner, profile, log, locate, 'after-prepare', res.targets)) {
        res.targets.push(t);
        targets[t.id] = t.point;
      }
    }
    const setupOps = d.ops.filter((x) => x.op !== 'launch');
    const shotDir = join(o.runDir, 'evidence');
    await mkdir(shotDir, { recursive: true });

    // ---- feature: one-time acceptance
    if (plan.category === 'feature') {
      res.acceptance = [];
      for (const item of plan.acceptance ?? []) {
        for (const a of item.actions) {
          d.label = a.node?.name ?? a.type;
          stats.steps++;
          await exec(a);
        }
        const png = await d.screenshot();
        stats.checkpointScreenshots++;
        const ev = join(shotDir, `${item.id}.png`);
        await writeFile(ev, png);
        const r = item.check.kind === 'ai' ? await evaluateAi(item.check, ask) : await evaluateVisual(d, profile, { ...item.check, onlyOnAnomaly: item.check.onlyOnAnomaly ?? false }, undefined, png);
        res.acceptance.push({ id: item.id, text: item.text, pass: r.pass, detail: r.detail, evidence: `evidence/${item.id}.png` });
        log(`acceptance ${item.id}: ${r.pass === null ? '未验证' : r.pass ? '满足' : '不满足'} — ${r.detail}`);
      }
      res.conclusion = featureConclusion(res.acceptance);
      const miss = res.acceptance.filter((x) => x.pass === false).map((x) => x.text);
      const unv = res.acceptance.filter((x) => x.pass === null).map((x) => x.text);
      res.conclusionDetail = `${miss.length ? `缺项：${miss.join('；')}` : '无缺项'}${unv.length ? `；未验证：${unv.join('；')}` : ''}`;
      return finish(res, t0, stats, vision0, text0);
    }

    // ---- suspected misuse: the correct path first, once, with the same checks
    let correctPathOk: boolean | undefined;
    if (plan.category === 'suspected-misuse' && plan.correctPath?.length) {
      for (const a of plan.correctPath) {
        d.label = `correct:${a.node?.name ?? a.element ?? a.type}`;
        await exec(a);
      }
      const png = await d.screenshot();
      stats.checkpointScreenshots++;
      const rs: CheckResult[] = [];
      for (const c of plan.checks) if (c.kind === 'visual-region') rs.push(await evaluateVisual(d, profile, c, ask, png));
      else if (c.kind === 'ai') rs.push(await evaluateAi(c, ask));
      correctPathOk = !rs.some((x) => x.pass === false) && !d.drainAnomalies().some((x) => HARD.includes(x.kind));
      log(`correct path: ${correctPathOk ? 'normal' : 'also shows the problem'}`);
    }

    // ---- loop
    const tracker = new VerdictTracker(plan.verdictRule);
    const reviewIssue = o.evidenceReview === false || !visionConfigured() ? undefined : await loadIssueOf(plan.issueRef);
    let dismissedRun = 0;
    const frames: RoundFrame[] = [];
    const roundOpsFrom: number[] = [];
    let stop = '';
    const visualChecks = plan.checks.filter((c) => c.kind === 'visual-region' || c.kind === 'baseline');
    // 'baseline' check: round 1 verifies the landing screen once (accessibility read of the quoted original)
    // and keeps it; later rounds must land on the same screen (hash of the content area).
    let baseline: { img: ReturnType<typeof decodePng>; box?: [number, number, number, number] } | undefined;
    const contentHash = (png: Buffer) => {
      const img = decodePng(png);
      return dHash(img, [0, Math.round(img.height * 0.12), img.width, Math.round(img.height * 0.68)]);
    };
    for (let round = 1; !stop; round++) {
      d.round = round;
      if (plan.launch === 'each-iteration' && round > 1) {
        d.label = 'relaunch';
        await d.launch();
        stats.launches++;
      }
      const roundAnoms: Anomaly[] = [];
      roundOpsFrom.push(d.ops.length);
      const stepsBefore = stats.steps;
      let roundHitReason = '';
      for (const a of plan.actions) {
        if (stats.steps >= maxSteps) {
          stop = `步数上限 ${maxSteps}`;
          break;
        }
        if (Date.now() - t0 > maxMs) {
          stop = `时长上限 ${maxMs / 60_000} 分钟`;
          break;
        }
        stats.steps++;
        d.step = stats.steps;
        d.label = a.node?.name ?? a.element ?? a.type;
        const budget = WATCHDOG_MS + (a.type === 'idle' ? idleMs(a) : 0) + (a.type === 'killApp' || a.type === 'reload' ? 10_000 : 0);
        const ok = await Promise.race([exec(a).then(() => true), sleep(budget).then(() => false)]);
        if (!ok) {
          stop = `看门狗：第 ${stats.steps} 步 ${d.label} 超过 ${budget / 1000}s`;
          res.incidents.push(await incident('watchdog', stop, round));
          break;
        }
        const an = d.drainAnomalies();
        for (const x of an) {
          stats.anomalyGateTriggers++;
          if (x.suspect) stats.suspectSignals++;
          roundAnoms.push(x);
          if (HARD.includes(x.kind) && !roundHitReason) {
            roundHitReason = `${x.kind}: ${x.detail.slice(0, 200)}`;
            log(`HIT step ${stats.steps}: ${roundHitReason}`);
            res.incidents.push(await incident(incidentKind(x.kind), x.detail, round));
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
      const results: CheckResult[] = [];
      let png: Buffer | undefined;
      if (!roundHitReason && (visualChecks.length || plan.checks.some((c) => c.kind === 'ai'))) {
        png = await d.screenshot();
        stats.checkpointScreenshots++;
      }
      for (const c of plan.checks) {
        if (c.kind === 'visual-region' && png) results.push(await evaluateVisual(d, profile, c, ask, png));
        else if (c.kind === 'ai' && png && c.onlyOnAnomaly === false) results.push(await evaluateAi(c, ask));
        else if (c.kind === 'process-alive' && inner instanceof AndroidDriver) {
          const alive = await inner.processAlive();
          results.push({ check: c, pass: c.want === 'absent' ? !alive : alive, detail: `process ${alive ? 'running' : 'not running'}` });
        }
        else if (c.kind === 'baseline' && png) {
          // Round 1: accessibility read confirms the quoted original is shown; its bubble becomes the reference.
          // Later rounds: that bubble must be on screen again (ink match, vertical search) — a jump elsewhere fails.
          if (!baseline) {
            const quoted = res.targets.find((t) => t.kind === 'quote-card')?.chosen.match(/^quote of "(.*)"$/)?.[1] ?? '';
            const box = inner instanceof AndroidDriver && quoted ? await quotedOriginalVisible(inner, quoted) : undefined;
            baseline = { img: decodePng(png), box };
            await writeFile(join(o.runDir, 'baseline.png'), png);
            results.push({ check: c, pass: !!box, detail: box ? `first jump shows the quoted original at ${JSON.stringify(box)} (accessibility check) — kept as reference` : 'first jump does NOT show the quoted original message' });
          } else if (baseline.box) {
            // 0.35: the jump briefly highlights the target bubble (tint differs by capture moment); another screen scores ~0.7.
            const m = regionMatch(decodePng(png), baseline.img, baseline.box, 1, 900);
            results.push({ check: c, pass: m.fraction <= BASELINE_TOLERANCE, detail: `quoted original ${m.fraction <= BASELINE_TOLERANCE ? `visible (dy ${m.dy})` : `NOT on screen (${Math.round(m.fraction * 100)}% of its marks missing)`}` });
          } else results.push({ check: c, pass: false, detail: 'no reference: the first jump already failed' });
        }
      }
      let failed = results.find((r) => r.pass === false);
      const hardHit = !!roundHitReason;
      if (failed && !hardHit && png && !(await onChat(png))) {
        // Operation drift (we are not where the plan thinks): not a finding. Re-enter and continue.
        stats.drifts++;
        await writeFile(join(o.runDir, `drift-round-${round}.png`), png);
        log(`round ${round}: operation drift (chat page not on screen) — re-entering, not counted`);
        failed = undefined;
        results.length = 0;
        await redoSetup();
        if (stats.drifts > 10) stop = '操作偏离过多（>10 次），停止';
      }
      if (failed && !roundHitReason) {
        roundHitReason = `check failed: ${failed.check.expect} — ${failed.detail}`;
        log(`HIT round ${round} step ${stats.steps}: ${roundHitReason}`);
      }
      if (png) {
        frames.push({ round, step: stats.steps, at: Date.now(), hash: dHash(decodePng(png)), png });
        if (frames.length > 60) frames.shift();
        for (const f of frames.slice(0, -10)) f.png = undefined;
      }
      let review: { verdict: EvidenceVerdict; note: string } | undefined;
      if (failed && !hardHit && res.incidents.length < 5 + (res.dismissed?.length ?? 0)) {
        const dir = await incident(failed.check.kind === 'visual-region' ? 'check-failed' : 'visual-anomaly', roundHitReason, round);
        res.incidents.push(dir);
        // The check only compares pixels: before the round counts, the recorded evidence must show what
        // the Issue describes. A rejected hit is kept (bundle + review) but does not count.
        if (reviewIssue) {
          const rv = await reviewIncident(dir, reviewIssue, { subcase: plan.title, log });
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
          d.label = `after:${a.node?.name ?? a.element ?? a.type}`;
          await exec(a);
        }
      if (tracker.record(!!roundHitReason)) stop = `判定规则满足（${'anyHit' in plan.verdictRule ? '命中 1 次' : '连续 3 次命中'}）`;
      if (round % 20 === 0) log(`round ${round}, steps ${stats.steps}, hits ${tracker.hits}, ${Math.round((Date.now() - t0) / 1000)}s`);
      if (web) await wfr!.rotate(web.context!);
    }
    // Action interval = gap between consecutive input operations inside a round (the round-end
    // checkpoint is not an action, §C.2).
    const intervals: number[] = [];
    // The gap from the last action into the first afterCheck op spans the checkpoint: not an action interval.
    const isAfter = (x: CoordOp) => (x.label ?? '').startsWith('after:');
    for (let i = 1; i < d.ops.length; i++) {
      const a = d.ops[i - 1];
      const b = d.ops[i];
      if (b.round > 0 && b.round === a.round && !LIFECYCLE_OPS.has(b.op) && !LIFECYCLE_OPS.has(a.op) && !(isAfter(b) && !isAfter(a))) intervals.push(b.at - a.at);
    }
    stats.avgIntervalMs = intervals.length ? Math.round(intervals.reduce((s, x) => s + x, 0) / intervals.length) : 0;
    stats.maxIntervalMs = intervals.length ? Math.max(...intervals) : 0;
    stats.intervalsOverCap = intervals.filter((x) => x > plan.limits.maxIntervalMs).length;
    stats.launches = d.ops.filter((x) => x.op === 'launch').length;
    res.conclusion = tracker.conclusion(plan.category);
    if (stop.startsWith('自动检查连续') && !tracker.reproduced()) res.conclusion = '执行失败';
    if (correctPathOk !== undefined) res.conclusion = !correctPathOk ? '转为 bug' : tracker.reproduced() ? '疑似误操作' : '未复现（上限内未出现）';
    res.conclusionDetail = `停止原因：${stop}；共 ${stats.rounds} 轮 ${stats.steps} 步，命中 ${tracker.hits} 次${tracker.hits ? `（第 ${tracker.hitRounds.slice(0, 10).join(', ')} 轮）` : ''}${res.dismissed?.length ? `；证据复核排除误报 ${res.dismissed.length} 次` : ''}`;
    return finish(res, t0, stats, vision0, text0);

    async function incident(kind: IncidentKind, detail: string, round: number): Promise<string> {
      const n = res.incidents.length + 1;
      const dir = incidentDir(o.runDir, n, kind);
      const at = Date.now();
      log(`incident ${n}-${kind} → ${dir}`);
      const cap = afr ? await afr.capture(dir, at) : wfr && web ? await wfr.capture(web.context!, dir, at) : undefined;
      const fromRound = Math.max(1, round - 20);
      const rounds: ReplayFile['rounds'] = [];
      for (let r = fromRound; r <= round; r++) rounds.push({ round: r, ops: d.ops.filter((x: CoordOp) => x.round === r && x.op !== 'launch'), endHash: frames.find((f) => f.round === r)?.hash });
      const replay: ReplayFile = {
        format: 'coord-v1',
        skillVersion: profile!.skillVersion,
        surface: plan.surface,
        profile: profile!.name,
        env: plan.env,
        url: web ? o.pool.webUrl(plan.env) : undefined,
        packageName: profile!.packageName,
        account: account.id,
        device: udid,
        launch: plan.launch,
        category: plan.category,
        verdictRule: plan.verdictRule,
        checks: plan.checks,
        targets: res.targets.map((t) => ({ id: t.id, point: t.point, chosen: t.chosen })),
        setupOps,
        rounds,
        incidentRound: round,
      };
      await writeIncident({
        runDir: o.runDir,
        n,
        kind,
        at,
        detail,
        plan,
        step: stats.steps,
        round,
        action: d.label,
        env: { account: account.id, device: udid, ...(cap && 'state' in cap ? cap.state : {}), browser: web ? `chromium ${web.browser?.version() ?? ''}` : undefined },
        ops: d.ops,
        frames,
        replay,
        videos: cap && 'videos' in cap ? cap.videos : undefined,
        traces: cap && 'traces' in cap ? cap.traces : undefined,
        logFrom: cap?.logFrom ?? at - 180_000,
        logTo: cap?.logTo ?? at,
        clockOffsetMs: afr?.clockOffsetMs,
        dir,
      });
      return dir;
    }
  } catch (err) {
    if (err instanceof SkillStaleError) {
      res.conclusion = 'SKILL 失效';
      res.conclusionDetail = err.message;
    }
    res.error = (err as Error).message.split('\n')[0];
    log(`error: ${res.error}`);
    return finish(res, t0, stats, vision0, text0);
  } finally {
    await afr?.stop().catch(() => {});
    if (sess?.web) await wfr?.stop(sess.web.context).catch(() => {});
    await closeSession(sess);
    o.pool.release(lease, o.devices);
  }
}

function finish(res: RunResult, t0: number, stats: Stats, vision0: number, text0: number): RunResult {
  res.finishedAt = new Date().toISOString();
  stats.durationSec = Math.round((Date.now() - t0) / 1000);
  stats.visionCalls = modelCalls.vision - vision0;
  stats.textModelCalls = modelCalls.text - text0;
  return res;
}

/** The Issue a plan comes from (issues/<id>.md), for evidence review; none for smoke / ad-hoc plans. */
async function loadIssueOf(ref: string): Promise<NormalizedIssue | undefined> {
  const f = resolve('issues', `${ref}.md`);
  return existsSync(f) ? parseIssue(ref, await readFile(f, 'utf8')) : undefined;
}

const idleMs = (a: PlannedAction) => Math.min(MAX_IDLE_MS, Math.max(0, Number(a.value ?? 1000)));

const DIRS: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** One plan action by coordinates (element / target → point through the profile and frozen targets). */
export async function execAction(a: PlannedAction, ctx: NodeContext, profile: Profile, targets: Record<string, Point>): Promise<void> {
  const d = ctx.driver;
  const pt = () => {
    if (!a.element) throw new Error(`${a.type} without element`);
    if (a.element.startsWith('target.')) {
      const p = targets[a.element.slice(7)];
      if (!p) throw new Error(`target ${a.element} not frozen`);
      return p;
    }
    return pointOf(profile, a.element);
  };
  const mid = { x: Math.round(profile.viewport.width / 2), y: Math.round(profile.viewport.height / 2) };
  switch (a.type) {
    case 'node':
      if (a.node?.name === 'teamily.login' && d instanceof RecordingDriver) await d.redacted(() => runNode(a.node!.name, a.node!.input ?? {}, ctx));
      else await runNode(a.node!.name, a.node!.input ?? {}, ctx);
      break;
    case 'tap':
      await d.tap(pt());
      break;
    case 'longPress':
      await d.longPress(pt());
      break;
    case 'type':
      if (a.element) await d.tap(pt());
      await d.type(a.value ?? '');
      break;
    case 'key':
      await d.key(a.value ?? 'Enter');
      break;
    case 'swipe': {
      const [dx, dy] = DIRS[a.value ?? 'up'] ?? DIRS.up;
      const from = a.element ? pt() : mid;
      await d.swipe(from, { x: from.x + dx * profile.viewport.width * 0.3, y: from.y + dy * profile.viewport.height * 0.3 });
      break;
    }
    case 'scroll': {
      const dy = (a.value === 'up' ? -1 : 1) * Math.round(profile.viewport.height * 0.4);
      await d.scroll(a.element ? pt() : mid, dy);
      break;
    }
    case 'back':
      await d.back();
      break;
    case 'wait':
      await sleep(Math.min(1000, Number(a.value ?? 300)));
      break;
    case 'launch':
      await d.launch();
      break;
    case 'exitApp':
    case 'killApp':
    case 'reload':
      if (d instanceof RecordingDriver) await d[a.type]();
      else await lifecycle(d, a.type);
      break;
    case 'idle':
      if (d instanceof RecordingDriver) await d.idle(idleMs(a));
      else await sleep(idleMs(a));
      break;
  }
  // Pace: the next input starts ≤ 950 ms after the previous one started (op time included).
  const lastAt = d instanceof RecordingDriver ? d.ops.at(-1)?.at : undefined;
  const wanted = Math.min(a.delayAfterMs ?? 300, 1000);
  await sleep(lastAt ? Math.max(0, Math.min(wanted, 950 - (Date.now() - lastAt))) : wanted);
}

export const runDirFor = (planId: string) => resolve('midscene_run/issues', `${planId}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
