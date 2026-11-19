// Executor (milestone 5 §C, split in W2-1): black-box, coordinate-driven. Orchestration only:
//   lease (account + endpoint slot) → session (launch once, sign in, home list, SKILL check)
//   → prepare (dynamic targets frozen, setup, precondition) → feature acceptance | [correct path] → loop
//   → verdict. Phases live in prepare.ts / phases.ts / loop.ts / checkpoint.ts / incident-hook.ts.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { modelCallListeners, modelCalls, setModelPurpose, visionConfigured } from '../../core/model/llm';
import { useCallLogs } from '../../core/context/logs';
import { isoMs, openTrajectory, type Trajectory } from '../../core/trajectory';
import type { CoordOp } from '../recorder/recording-driver';
import { TEAMILY_PACKAGE } from '../../drivers/factory';
import { errorKind, sleep } from '../../drivers/types';
import { AndroidFlightRecorder } from '../recorder/android-recorder';
import type { EvidenceVerdict } from '../recorder/evidence-review';
import { type JankStats, parseGfxinfo } from '../stats';
import { adb } from '../../core/adb';
import type { DetectKind } from '../detect';
import { WebFlightRecorder } from '../recorder/web-recorder';
import { loadIssueOf } from '../../issue/paths';
import type { AccountPool, Lease } from '../../platform/accounts/account-pool';
import { onAndroid, onPlaywright } from '../../platform/accounts/types';
import type { DevicePool } from '../../platform/device-pool';
import type { PlannedAction, TestPlan } from '../../platform/schema/test-plan';
import { SkillStaleError } from '../../skills/profile';
import { percentiles, treeStats } from '../../core/tree-backend';
import { PreTapGuard } from '../pretap';
import type { NodeContext } from '../../skills/teamily/nodes';
import { execAction } from './actions';
import { locate, locateTally, locateText } from '../locate';
import { composerText } from '../observe';
import { regionShows, visionAsker } from '../checks';
import type { RunCtx } from './context';
import { runLoop } from './loop';
import { runAcceptance, runCorrectPath } from './phases';
import { prepare } from './prepare';
import { runWarmup, WarmupError } from './warmup';
import { closeSession, enterApp, openSession, packageOf, type Session, staleShotPath } from '../session';
import { newStats, type Stats } from '../stats';
import { type FrozenTarget, visionLocator } from './targets';
import { type Conclusion, NO_VERDICT } from '../verdict';
import { classifyFailure, type EnvSnapshot, type Failure } from '../failure';
import { cleanStart, requireNow, runEpilogue, teardown } from './isolation';
import { buildManifest, type Manifest, writeManifest } from '../manifest';
import { envSnapshot, type PreflightResult } from '../preflight';
import { leaseFor, preflightFor } from '../lease';
import type { Attempts } from '../stats';
import { expandAction, newRunToken } from './template';
import { AndroidDriver } from '../../drivers/android';
import { CancelledError, type RunHooks } from '../../platform/lifecycle/runtime';
import { stepText } from '../../platform/views';
import { loadConversations } from '../../platform/conversations';
import { pageOf, startPageRecording } from '../pages';

export { execAction } from './actions';
export type { Stats } from '../stats';

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
  /** Warm-up round with per-step verification before the loop (default on). */
  warmup?: boolean;
  /** Use this profile instead of the SKILL cache (tests). */
  profile?: import('../../skills/profile').Profile;
  /** Stop after this many valid attempts (overrides the plan's limits.maxRounds). */
  maxRounds?: number;
  /** Run marker (default: a fresh one per run). */
  runTag?: string;
  /** Device preflight before anything is launched (default on; W2-2 §4.2). */
  preflight?: boolean;
  /** Task lifecycle (W2-3 §4): progress, side-effect ledger (before each effect), cancel at step boundaries. */
  hooks?: RunHooks;
}

export interface RunResult {
  planId: string;
  issue: string;
  title: string;
  category: TestPlan['category'];
  surface: TestPlan['surface'];
  substitution?: TestPlan['substitution'];
  env: TestPlan['env'];
  /** Plan coverage of the contract's postcondition (report note when not covered). */
  coverage?: TestPlan['coverage'];
  /** Contract phenomenon (what a hit means). */
  phenomenon?: string;
  /** Warm-up round: per-step verification and its (recorded only) checkpoint. */
  warmup?: { steps: import('./warmup').WarmupStep[]; checks: { kind: string; pass: boolean | null; detail: string }[] };
  /** SKILL elements / reference regions located on the live screen this run (refactor P3). */
  located?: import('../skill-resolver').LocateRecord[];
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
  /** Problems the deterministic detectors saw at round ends (W2-5 §6); never part of the Issue verdict. */
  incidental?: Incidental[];
  /** android-app: frame statistics over the loop (metric only). */
  jank?: JankStats;
  incidents: string[];
  targets: FrozenTarget[];
  acceptance?: { id: string; text: string; pass: boolean | null; detail: string; evidence?: string }[];
  roundLog: { round: number; step: number; results: { kind: string; pass: boolean | null; detail: string }[] }[];
  error?: string;
  /** Run marker written into this run's drafts / messages (W2-2 §4.3). */
  runTag?: string;
  /** Bug runs: valid attempts, drift rounds, hits, per-round rate + Wilson interval (W2-2 §3.1; no upper bound since W3-1 K3). */
  attempts?: Attempts;
  /** Phase durations in ms: lease, preflight, launch, login, prepare, warmup, loop, teardown. */
  phases?: Record<string, number>;
  /** No verdict (执行失败 / 计划不可执行 / SKILL 失效 / 环境不合格): environment or tool (W2-2 §3.3). */
  failure?: Failure;
  manifest?: Manifest;
  /** Clean start / teardown steps actually taken. */
  isolation?: { cleanStart: string[]; teardown: string[] };
  /** Epilogue observation (record only). */
  epilogue?: { expect: string; pass: boolean | null; detail: string };
  /** Web runs without a verdict: the flight recorder's last trace chunks in the run dir (W2-2 §6). */
  traces?: string[];
  /** Stopped by a cancel request (W2-3 §4.3 L2): incomplete, no verdict. */
  cancelled?: boolean;
  /** W3-1: expect / baseline reads that did not hold (which step, what was read) — revision material. */
  expectLog?: import('./expect').ExpectRecord[];
  /** W3-1: suspect signals with the logcat line that raised them. */
  suspects?: { round: number; step: number; kind: string; detail: string }[];
  /** W3-1: targets that failed their `must` at preparation (each try). */
  mustLog?: { id: string; try: number; detail: string; point: { x: number; y: number } }[];
  /** W3-1: sampled low-resolution screenshots (every 10 rounds, ring of 30). */
  samples?: string[];
  /** W3-1 §8.1: executability of the plan version in this run. */
  executability?: { validated: boolean; warmup: 'passed' | 'failed' | 'not-run'; driftRate: number; unstable: boolean };
  /** Sub-case of a model-authored plan (main / control / s1 …). */
  sub?: string;
  /** W3-7 §8.1 ①: the plan path being executed when the run stopped (preparation / warm-up). */
  at?: string;
  /** W3-7 §8.1 ②: the cause the stopping error carried (NodeError / tagged RoundDrift). */
  errorKind?: import('../../drivers/types').FailureKind;
  /** W3-7 §8.1 ③: the screen when the run stopped (texts with centres, <= 200; the page it matches). */
  evidence?: { page: string; texts: { t: string; x: number; y: number }[] };
  /** Plan version (audit.version) the run executed; undefined = a plan from before W3-1 ("v1 计划"). */
  planVersion?: number;
  /** Report lead (W2-2 §3.2): trigger path / location / suspected mechanism, each with its basis. */
  lead?: { trigger: string; triggerBasis: string; location: string; locationBasis: string; mechanism: string };
}

export interface Incidental {
  n: number;
  round: number;
  step: number;
  kind: DetectKind;
  description: string;
  incident: string;
  review?: EvidenceVerdict;
  /** The evidence review agrees (a finding worth an Issue draft). */
  counted: boolean;
}

export async function runPlan(o: RunOptions): Promise<RunResult> {
  const plan = o.plan;
  const log = o.log ?? ((s) => console.log(`[run] ${s}`));
  await mkdir(o.runDir, { recursive: true });
  const endCallLogs = useCallLogs(o.runDir);
  const t0 = Date.now();
  // Declared before done(): an early return (preflight / lease) reads it.
  let sess: Session | undefined;
  const stats = newStats();
  const calls0 = { ...modelCalls, byPurpose: { ...modelCalls.byPurpose }, tokens: { ...modelCalls.tokens } };
  const locate0 = JSON.parse(JSON.stringify(locateTally)) as typeof locateTally;
  const tree0 = { reads: Object.fromEntries(Object.entries(treeStats.reads).map(([k, v]) => [k, v.n])), fallbacks: treeStats.fallbacks.length };
  let guard: PreTapGuard | undefined;
  // W3-4 §8.2′: the plan run's snapshots go into the page recording too.
  const stopPages = startPageRecording(plan.surface);
  const runTag = o.runTag ?? newRunToken();
  const res: RunResult = { planId: plan.id, issue: plan.issueRef, title: plan.title, category: plan.category, surface: plan.surface, substitution: plan.substitution, env: plan.env, coverage: plan.coverage, phenomenon: plan.contract?.observable.phenomenon, conclusion: '执行失败', conclusionDetail: '', startedAt: new Date(t0).toISOString(), finishedAt: '', stats, hits: [], incidents: [], targets: [], roundLog: [], runTag, phases: {}, ...(plan.audit ? { planVersion: plan.audit.version, sub: plan.audit.sub } : {}) };
  const phase = (name: string, since: number) => {
    res.phases![name] = (res.phases![name] ?? 0) + (Date.now() - since);
  };
  // Raw trajectory (trajectory-v1): the manifest first, then the plan; live model calls; the rest at the end.
  const traj = openTrajectory(join(o.runDir, 'trajectory.jsonl'));
  let preflight: PreflightResult | undefined;
  let headDone = false;
  const head = (account?: string, udid?: string) => {
    if (headDone) return;
    headDone = true;
    const pkg = packageOf(plan.surface);
    res.manifest = buildManifest({ plan, runId: `${plan.id}-${t0}`, startedAt: res.startedAt, runTag, profile: o.profile?.name, account, device: preflight?.device ?? (udid ? { udid, app: pkg ? { package: pkg } : undefined } : undefined), preflight });
    traj.emit('manifest', res.manifest as unknown as Record<string, unknown>);
    traj.emit('plan', { planId: plan.id, issue: plan.issueRef, category: plan.category, surface: plan.surface, env: plan.env, draftHash: plan.provenance.draftHash, planVersion: plan.audit?.version, generatedBy: plan.provenance.generatedBy });
    if (plan.contract) traj.emit('contract', plan.contract as unknown as Record<string, unknown>);
    if (plan.audit) traj.emit('audit', plan.audit as unknown as Record<string, unknown>);
  };
  const onCall = (e: { kind: string; purpose: string }) => traj.emit('model-call', { model: e.kind, purpose: e.purpose });
  modelCallListeners.add(onCall);
  let envAtFailure: EnvSnapshot | undefined;
  let cRef: RunCtx | undefined;
  /** Side-effect-free reset at the end (once; never throws). */
  const reset = async (c: RunCtx) => {
    if (res.isolation?.teardown.length) return;
    const t = Date.now();
    const did = await teardown(c).catch((e) => [`复位失败：${(e as Error).message.split('\n')[0]}`]);
    if (res.isolation) res.isolation.teardown = did.length ? did : ['（无需复位）'];
    phase('teardown', t);
  };
  const done = async () => {
    modelCallListeners.delete(onCall);
    // W3-1 §8.4: the sampled screenshots go into every incident bundle of the run (the hit's own frames are there already).
    for (const i of res.samples?.length ? res.incidents : []) {
      await mkdir(join(i, 'samples'), { recursive: true }).catch(() => {});
      for (const f of res.samples!) await copyFile(f, join(i, 'samples', basename(f))).catch(() => {});
    }
    head(res.account, res.device);
    const located = (sess?.profile.resolver as import('../skill-resolver').SkillResolver | undefined)?.located;
    if (located?.length) res.located = [...located];
    // The conversation the run constructs in / reads (names only).
    if (res.manifest?.account) res.manifest.account.conversation = res.targets.find((t) => /conversation/.test(t.kind))?.chosen;
    if (NO_VERDICT.includes(res.conclusion)) res.failure = classifyFailure(res.conclusion, res.error ?? res.conclusionDetail, envAtFailure);
    if (plan.category !== 'feature') res.lead = leadOf(plan, res);
    if (res.manifest) await writeManifest(o.runDir, res.manifest).catch(() => {});
    if (guard?.tally.checked) stats.preTap = { ...guard.tally, lines: guard.reportLines() };
    const reads = Object.fromEntries(
      Object.entries(treeStats.reads)
        .map(([k, v]) => [k, v.n - (tree0.reads[k] ?? 0), v.ms] as const)
        .filter(([, n]) => n > 0)
        .map(([k, n, ms]) => [k, { n, ...(({ p50, p95 }) => ({ p50, p95 }))(percentiles(ms.slice(-n))) }]),
    );
    const fb = treeStats.fallbacks.slice(tree0.fallbacks);
    if (Object.keys(reads).length || fb.length) stats.treeBackend = { reads, fallbacks: fb.length, ...(fb[0] ? { firstFallback: fb[0].reason } : {}) };
    stats.locateTiers = Object.fromEntries(Object.entries(locateTally).map(([k, v]) => [k, { n: v.n - (locate0[k]?.n ?? 0), ms: v.ms - (locate0[k]?.ms ?? 0) }]).filter(([, v]) => (v as { n: number }).n > 0));
    const out = finish(res, t0, stats, calls0);
    endCallLogs();
    writeTrajectory(traj, out, opsOf());
    await traj.close({ runId: `${plan.id}-${t0}`, query: `Issue ${plan.issueRef} ${plan.title}`, startedAt: isoMs(t0), endedAt: isoMs(Date.now()), model: process.env.MIDSCENE_MODEL_NAME ?? '', account: res.account ?? '', output: { conclusion: out.conclusion, detail: out.conclusionDetail, stats: out.stats, coverage: out.coverage } });
    return out;
  };
  let opsOf: () => CoordOp[] = () => [];

  // ---- lease: account + slot of an endpoint (a phone for Android surfaces, this computer otherwise)
  const taskId = o.taskId ?? `run-${plan.id}-${t0}`;
  const tLease = Date.now();
  const leased = await leaseFor({ pool: o.pool, devices: o.devices, env: plan.env, surface: plan.surface, accountId: plan.account, udid: o.udid, taskId, preflight: o.preflight, hooks: o.hooks, log });
  if (leased.error !== undefined) {
    res.error = leased.error;
    return done();
  }
  const { lease, account, udid } = leased;
  res.account = account.id;
  res.device = onAndroid(plan.surface) ? udid : undefined;
  phase('lease', tLease);

  // ---- preflight (W2-2 §4.2): an unfit endpoint is 环境不合格 — nothing is launched or tapped.
  o.hooks?.phase('preflight');
  const tPf = Date.now();
  preflight = await preflightFor({ pool: o.pool, surface: plan.surface, preflight: o.preflight, hooks: o.hooks, log }, account.id, udid);
  if (preflight) {
    phase('preflight', tPf);
    if (!preflight.ok) {
      res.conclusion = '环境不合格';
      res.conclusionDetail = `预检不合格：${preflight.reason}`;
      o.pool.release(lease, o.devices);
      return done();
    }
  }
  head(account.id, udid);

  let afr: AndroidFlightRecorder | undefined;
  let wfr: WebFlightRecorder | undefined;
  const flightDir = join(o.runDir, '.flight');
  try {
    // ---- session: profile + driver + flight recorder, launch once, sign in, home list, SKILL check
    if (onPlaywright(plan.surface)) wfr = new WebFlightRecorder(flightDir);
    if (onAndroid(plan.surface) && udid) afr = new AndroidFlightRecorder(udid, packageOf(plan.surface) ?? TEAMILY_PACKAGE, flightDir);
    o.hooks?.phase('launch');
    sess = await openSession({ surface: plan.surface, env: plan.env, account: account.id, udid, pool: o.pool, headed: o.headed, profile: o.profile, onLog: afr?.onLog, onConsole: wfr?.onConsole, log });
    const s = sess;
    opsOf = () => s.d.ops;
    // Pre-tap check (W2-4 §4.3): on for entering / preparation / re-entry only — never during the loop.
    const g = (guard = new PreTapGuard(s.inner, { dir: o.runDir, log }).attach(s.d));
    // Clean start (W2-2 §4.3): the App is cold-started, never resumed on a screen an earlier run left.
    if (plan.surface === 'android-app' && s.inner instanceof AndroidDriver) await s.inner.killApp();
    await afr?.start();
    await g.during('enter', () => enterApp(s, {
      afterLaunch: async () => {
        if (s.web) await wfr!.start(s.web.context!, s.web.page!);
      },
      // Phones: the bottom bar looks the same on every tab — make sure the chat tab is the one showing.
      chatTab: plan.setup.some((a) => a.node?.name === 'teamily.openConversation'),
      staleShot: staleShotPath(o.runDir),
      onPhase: (name, ms) => (res.phases![name] = ms),
    }));
    stats.launches++;

    const targets: Record<string, import('../../drivers/types').Point> = {};
    let signedInAs: 'self' | 'other' = 'self';
    const nodeCtx: NodeContext = {
      driver: s.d,
      profile: s.profile,
      targets,
      credentials: () => o.pool.backend.get(account.id),
      // A second pool account for alternating logins on one phone (user 2026-11-09): the allow-listed member first.
      otherCredentials: () => {
        const member = loadConversations().construct.member;
        const ok = o.pool.list(plan.env).filter((a) => a.id !== account.id && a.status !== 'disabled' && a.status !== 'login-failed');
        const other = ok.find((a) => member && a.email.split('@')[0] === member) ?? ok[0];
        return other ? o.pool.backend.get(other.id) : undefined;
      },
      onAccountSwitch: (who) => {
        signedInAs = who;
        log(`account: signed in as ${who === 'self' ? `the leased account ${account.id}` : 'the second pool account'}`);
      },
      // prepare-only Nodes (validator keeps them out of the loop)
      locate: async (desc, texts, newest, textOnly) => {
        const r = textOnly ? await locateText(s.inner, texts, newest) : await locate(s.inner, desc, { texts, newest, purpose: 'prep' });
        if (r) await g.remember(r.point, { purpose: desc.slice(0, 80), ...r.ref, ...(r.ref ? {} : { png: await s.inner.screenshot().catch(() => undefined) }) });
        return r?.point ?? null;
      },
      regionShows: (img, key) => regionShows(img, s.profile, key),
      findAll: async (texts, cls) => {
        if (!(s.inner instanceof AndroidDriver)) return [];
        const { dumpTree } = await import('../../core/ui-tree');
        const nodes = await dumpTree(s.inner.o.udid, '', 2);
        return nodes
          .filter((n) => (!texts.length || texts.includes(n.text.trim()) || texts.includes(n.desc.trim())) && (!cls || cls.test(n.cls)))
          .map((n) => ({ point: { x: Math.round((n.x1 + n.x2) / 2), y: Math.round((n.y1 + n.y2) / 2) }, box: [n.x1, n.y1, n.x2 - n.x1, n.y2 - n.y1] as [number, number, number, number], cls: n.cls, clickable: n.clickable, label: n.text || n.desc }));
      },
      onFreeze: (id, point, chosen) => res.targets.push({ id, kind: 'picker-row', point, chosen, reason: 'located by its literal text (①) at preparation', by: 'text' }),
    };
    const c: RunCtx = {
      plan,
      o,
      log,
      res,
      stats,
      sess: s,
      account: account.id,
      udid,
      t0,
      ask: await visionAsker(s.web ?? (s.inner as any)),
      locate: await visionLocator(s.web ?? (s.inner as any)),
      targets,
      // {token} / {round} → this run's marker and the current round; `require` steps read ① (no input).
      exec: (a: PlannedAction) => {
        const x = expandAction(a, { token: runTag, round: s.d.round });
        o.hooks?.beforeAction(x, { round: s.d.round, step: s.d.step, label: s.d.label, target: (id) => {
          // Only a title read from the screen names a conversation; a vision pick knows its description only.
          const t = res.targets.find((x) => x.id === id);
          return t && (t.by === 'model' || t.by === 'rules') ? t.chosen : undefined;
        }, budgetMs: x.type === 'idle' ? 120_000 + Number(x.value ?? 0) : undefined });
        return x.type === 'require' ? requireNow(c, x) : execAction(x, nodeCtx, s.profile, targets);
      },
      frames: [],
      setupOps: [],
      afr,
      wfr,
      guard: g,
      signedInAs: () => signedInAs,
    };
    cRef = c;
    setModelPurpose('prep');
    nodeCtx.composerText = () => composerText(s.inner);
    const tPrep = Date.now();
    o.hooks?.phase('prepare');
    res.isolation = { cleanStart: [], teardown: [] };
    await g.during('prepare', () =>
      prepare(c, async () => {
        res.isolation!.cleanStart = await cleanStart(c);
      }),
    );
    phase('prepare', tPrep);
    nodeCtx.composerText = undefined; // the loop reads no hierarchy
    // The screen the plan acts on (outside the loop): the Web plan page marks its steps on it (§7).
    await s.inner.screenshot().then((png) => writeFile(join(o.runDir, 'screen.png'), png)).catch(() => {});
    if (plan.category === 'feature') {
      setModelPurpose('acceptance');
      o.hooks?.phase('loop');
      await runAcceptance(c);
      o.hooks?.phase('finishing');
      await reset(c);
      return done();
    }
    const correctPathOk = await runCorrectPath(c);
    setModelPurpose('warmup');
    // Smoke plans send for real: no extra round.
    const tWarm = Date.now();
    o.hooks?.phase('warmup');
    if (o.warmup !== false && plan.issueRef !== 'smoke') await runWarmup(c);
    phase('warmup', tWarm);
    setModelPurpose('checkpoint');
    const issue = o.evidenceReview === false || !visionConfigured() ? undefined : loadIssueOf(plan.issueRef);
    // Evidence review compares against the contract's phenomenon (W2-1 §5.6), else the Issue's actual result.
    const reviewIssue = issue && plan.contract ? { ...issue, actual: plan.contract.observable.phenomenon } : issue;
    const tLoop = Date.now();
    o.hooks?.phase('loop');
    // Inside the loop nothing is located: the SKILL cache only (D2).
    if (s.profile.resolver) s.profile.resolver.inLoop = true;
    // Frame statistics (W2-5 §8.3): reset before the loop, read once after it — no command inside it (D2).
    const pkg = s.profile.packageName;
    const gfx = plan.surface === 'android-app' && !!s.udid && !!pkg && (await adb(['shell', 'dumpsys', 'gfxinfo', pkg, 'reset'], s.udid, 10_000).then(() => true).catch(() => false));
    try {
      await runLoop(c, { reviewIssue, correctPathOk });
    } finally {
      if (s.profile.resolver) s.profile.resolver.inLoop = false;
    }
    if (gfx) res.jank = parseGfxinfo(await adb(['shell', 'dumpsys', 'gfxinfo', pkg!], s.udid, 10_000).catch(() => ''));
    o.hooks?.phase('finishing');
    await runEpilogue(c).catch((e) => log(`epilogue failed: ${(e as Error).message.split('\n')[0]}`));
    phase('loop', tLoop);
    await reset(c);
    return done();
  } catch (err) {
    if (err instanceof SkillStaleError) {
      res.conclusion = 'SKILL 失效';
      res.conclusionDetail = err.message;
    }
    if (err instanceof WarmupError) {
      res.conclusion = '计划不可执行';
      res.conclusionDetail = err.message;
      res.warmup = { steps: err.steps, checks: [] };
      res.executability = { validated: true, warmup: 'failed', driftRate: 0, unstable: false };
    }
    if (err instanceof CancelledError) res.cancelled = true;
    o.hooks?.phase('finishing');
    res.errorKind = errorKind(err) ?? (err instanceof WarmupError ? err.step.kind : undefined);
    // W3-7 §8.1 ③: what was on screen when it stopped — gone after the reset / next cold start.
    if (sess && udid && onAndroid(plan.surface)) res.evidence = await screenEvidence(udid).catch(() => undefined);
    res.error = errorLine(err);
    log(`error: ${res.error}`);
    // The screen and the device state at the moment of the error (diagnosis: environment or tool).
    if (sess) await sess.d.screenshot().then((png) => writeFile(join(o.runDir, 'error.png'), png)).catch(() => {});
    if (udid && onAndroid(plan.surface)) envAtFailure = await envSnapshot(udid, sess?.profile.packageName ?? TEAMILY_PACKAGE).catch(() => undefined);
    if (cRef) await reset(cRef);
    return done();
  } finally {
    stopPages();
    setModelPurpose('other');
    await afr?.stop().catch(() => {});
    // No verdict on the web (执行失败 / 计划不可执行): keep the last trace chunks for diagnosis.
    if (sess?.web && wfr && (res.conclusion === '执行失败' || res.conclusion === '计划不可执行')) {
      res.traces = await wfr.saveLast(sess.web.context!, o.runDir).catch((e) => {
        log(`trace not saved: ${(e as Error).message.split('\n')[0]}`);
        return [];
      });
      if (res.traces.length) log(`trace → ${join(o.runDir, res.traces[0])}`);
    }
    if (sess?.web) await wfr?.stop(sess.web.context).catch(() => {});
    await closeSession(sess);
    o.pool.release(lease, o.devices);
  }
}

/** W3-7 §8.1 ③: the screen's texts (with centres, at most 200) and the page they match, read from the tree. */
export async function screenEvidence(udid: string): Promise<NonNullable<RunResult['evidence']>> {
  const { dumpTree } = await import('../../core/ui-tree');
  const nodes = await dumpTree(udid, '', 2);
  const texts = nodes
    .map((n) => ({ t: (n.text || n.desc).trim(), x: Math.round((n.x1 + n.x2) / 2), y: Math.round((n.y1 + n.y2) / 2) }))
    .filter((n) => n.t)
    .slice(0, 200);
  return { page: pageOf(nodes).id, texts };
}

/** Pure: where a check looks (report lead). */
export function checkLocation(k: TestPlan['checks'][number]): string {
  if (k.kind === 'text') {
    const s = k.scope ?? 'screen';
    if (s === 'composer') return '聊天页输入框（chat.composer 的文字）';
    if (s === 'quote-cards') return '聊天页引用块';
    if (s === 'screen') return '当前屏幕文字';
    if ('message' in s) return `聊天页本轮最新一条含「${s.message}」的消息气泡`;
    if ('targetBubble' in s) return `目标 ${s.targetBubble} 的消息气泡及其下方的反应行`;
    return `目标 ${s.target} 附近`;
  }
  if (k.kind === 'visual-region') return `${k.page} 页 ${k.region} 区域`;
  if (k.kind === 'crash' || k.kind === 'page-error' || k.kind === 'console-error') return '整个 App / 页面（崩溃 / 页面错误）';
  if (k.kind === 'keyboard') return '软键盘（系统状态）';
  if (k.kind === 'baseline') return '点引用后的落点';
  if (k.kind === 'process-alive') return 'App 进程';
  return '屏幕（视觉判断）';
}

/** Pure: report lead lines of a bug run (W2-2 §3.2). */
export function leadOf(plan: TestPlan, r: Pick<RunResult, 'hits' | 'attempts' | 'runTag'>): NonNullable<RunResult['lead']> {
  const tag = (s: string) => s.replace(/\{token\}/g, r.runTag ?? '<运行标记>').replace(/\{round\}/g, '<轮号>');
  // The same plain-Chinese step rendering as the plan view (W2-3 §6.1).
  const step = (a: PlannedAction) => stepText(a, plan, true).text;
  const hitRounds = r.hits.map((h) => h.round).slice(0, 10);
  const k = plan.checks[0];
  return {
    trigger: tag(plan.actions.map(step).join(' → ')),
    triggerBasis: `计划动作，每轮执行${r.attempts ? `；${r.attempts.valid} 次有效尝试` : ''}${hitRounds.length ? `，命中轮次 ${hitRounds.join(', ')}` : '，无命中'}`,
    location: k ? tag(checkLocation(k)) : '（计划无检查）',
    locationBasis: k ? `检查「${k.expect}」${r.hits[0] ? `；首次命中：${r.hits[0].reason.slice(0, 160)}` : ''}` : '-',
    mechanism: plan.contract?.suspectedMechanism || '契约未给出',
  };
}

/** Run record → trajectory events (targets, warm-up, ops, round checks, hits, incidents, verdict). */
function writeTrajectory(traj: Trajectory, r: RunResult, ops: CoordOp[]): void {
  if (r.account) traj.emit('lease', { account: r.account, device: r.device, surface: r.surface });
  for (const t of r.targets) traj.emit('prep.target', { id: t.id, targetKind: t.kind, chosen: t.chosen, point: t.point, by: t.by, reason: t.reason });
  for (const w of r.warmup?.steps ?? []) traj.emit('warmup.step', { ...w });
  for (const x of r.expectLog ?? []) traj.emit(x.role === 'baseline' ? 'baseline' : 'expect', { ...x });
  for (const x of r.suspects ?? []) traj.emit('suspect', { ...x });
  for (const x of r.mustLog ?? []) traj.emit('must', { ...x });
  for (const f of r.samples ?? []) traj.emit('sample', { file: f });
  for (const l of r.located ?? []) traj.emit('located', { ...l });
  for (const op of ops) traj.emit('op', { ...op });
  for (const l of r.roundLog) traj.emit('observe', { round: l.round, step: l.step, results: l.results });
  for (const [tier, v] of Object.entries(r.stats.locateTiers ?? {})) traj.emit('locate', { tier, ...v });
  for (const h of r.hits) traj.emit('hit', { ...h });
  for (const x of r.dismissed ?? []) traj.emit('dismissed', { ...x });
  for (const i of r.incidents) traj.emit('incident', { dir: i });
  traj.emit('verdict', { conclusion: r.conclusion, detail: r.conclusionDetail, error: r.error, stats: r.stats });
}

function finish(res: RunResult, t0: number, stats: Stats, calls0: typeof modelCalls): RunResult {
  res.finishedAt = new Date().toISOString();
  stats.durationSec = Math.round((Date.now() - t0) / 1000);
  stats.visionCalls = modelCalls.vision - calls0.vision;
  stats.textModelCalls = modelCalls.text - calls0.text;
  stats.tokens = { input: modelCalls.tokens.input - calls0.tokens.input, output: modelCalls.tokens.output - calls0.tokens.output, cached: modelCalls.tokens.cached - calls0.tokens.cached };
  stats.modelCallsByPurpose = Object.fromEntries(Object.entries(modelCalls.byPurpose).map(([k, v]) => [k, v - (calls0.byPurpose[k] ?? 0)]).filter(([, v]) => (v as number) > 0));
  return res;
}

export const runDirFor = (planId: string) => resolve('midscene_run/issues', `${planId}-${new Date().toISOString().replace(/[:.]/g, '-')}`);

/** One readable line of an error (a zod error is a JSON list: name its first issues instead of "["). */
export function errorLine(err: unknown): string {
  const e = err as Error & { issues?: { path: (string | number)[]; message: string }[] };
  if (Array.isArray(e?.issues) && e.issues.length) return `invalid input: ${e.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).slice(0, 3).join('; ')}`;
  return String(e?.message ?? err).split('\n')[0];
}
