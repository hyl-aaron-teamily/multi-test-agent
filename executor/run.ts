// Executor (milestone 5 §C, split in W2-1): black-box, coordinate-driven. Orchestration only:
//   lease (account + endpoint slot) → session (launch once, sign in, home list, SKILL check)
//   → prepare (dynamic targets frozen, setup, precondition) → feature acceptance | [correct path] → loop
//   → verdict. Phases live in prepare.ts / phases.ts / loop.ts / checkpoint.ts / incident-hook.ts.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { modelCallListeners, modelCalls, setModelPurpose, visionConfigured } from '../core/model/llm';
import { isoMs, openTrajectory, type Trajectory } from '../core/trajectory';
import type { CoordOp } from '../incident/recording-driver';
import { profileKey, TEAMILY_PACKAGE } from '../drivers/factory';
import { sleep } from '../drivers/types';
import { AndroidFlightRecorder } from '../incident/android-recorder';
import type { EvidenceVerdict } from '../incident/evidence-review';
import { WebFlightRecorder } from '../incident/web-recorder';
import { loadIssueOf } from '../issue/paths';
import type { AccountPool, Lease } from '../platform/accounts/account-pool';
import { onAndroid, onPlaywright } from '../platform/accounts/types';
import type { DevicePool } from '../platform/device-pool';
import type { PlannedAction, TestPlan } from '../platform/schema/test-plan';
import { loadProfile, SkillStaleError } from '../skills/profile';
import type { NodeContext } from '../skills/teamily/nodes';
import { execAction } from './actions';
import { locate, locateTally, locateText } from './locate';
import { composerText } from './observe';
import { visionAsker } from './checks';
import type { RunCtx } from './context';
import { runLoop } from './loop';
import { runAcceptance, runCorrectPath } from './phases';
import { prepare } from './prepare';
import { runWarmup, WarmupError } from './warmup';
import { closeSession, enterApp, openSession, type Session, staleShotPath } from './session';
import { newStats, type Stats } from './stats';
import { type FrozenTarget, visionLocator } from './targets';
import { type Conclusion, NO_VERDICT } from './verdict';
import { classifyFailure, type EnvSnapshot, type Failure } from './failure';
import { cleanStart, requireNow, runEpilogue, teardown } from './isolation';
import { buildManifest, type Manifest, writeManifest } from './manifest';
import { envSnapshot, preflightAndroid, preflightWeb, type PreflightResult } from './preflight';
import { ensureWebSession, type PlaywrightSurface } from './login/sessions';
import type { Attempts } from './stats';
import { expandAction, newRunToken } from './template';
import { AndroidDriver } from '../drivers/android';
import { CancelledError, type RunHooks } from '../platform/lifecycle/runtime';
import { stepText } from '../platform/views';

export { execAction } from './actions';
export type { Stats } from './stats';

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
  /** Use this profile instead of the calibrated one (acceptance tests with a modified copy). */
  profile?: import('../skills/profile').Profile;
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
  /** Fixed elements re-resolved by fingerprint this run (calibrated profile unchanged). */
  healed?: import('./heal').Healed[];
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
  /** Run marker written into this run's drafts / messages (W2-2 §4.3). */
  runTag?: string;
  /** Bug runs: valid attempts, drift rounds, hits, per-round rate + Wilson interval / 3/n bound (W2-2 §3.1). */
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
  /** Report lead (W2-2 §3.2): trigger path / location / suspected mechanism, each with its basis. */
  lead?: { trigger: string; triggerBasis: string; location: string; locationBasis: string; mechanism: string };
}

export async function runPlan(o: RunOptions): Promise<RunResult> {
  const plan = o.plan;
  const log = o.log ?? ((s) => console.log(`[run] ${s}`));
  await mkdir(o.runDir, { recursive: true });
  const t0 = Date.now();
  const stats = newStats();
  const calls0 = { ...modelCalls, byPurpose: { ...modelCalls.byPurpose } };
  const locate0 = JSON.parse(JSON.stringify(locateTally)) as typeof locateTally;
  const runTag = o.runTag ?? newRunToken();
  const res: RunResult = { planId: plan.id, issue: plan.issueRef, title: plan.title, category: plan.category, surface: plan.surface, substitution: plan.substitution, env: plan.env, coverage: plan.coverage, phenomenon: plan.contract?.observable.phenomenon, conclusion: '执行失败', conclusionDetail: '', startedAt: new Date(t0).toISOString(), finishedAt: '', stats, hits: [], incidents: [], targets: [], roundLog: [], runTag, phases: {} };
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
    const prof = o.profile ?? loadProfile(profileKey(plan.surface, plan.env, udid));
    res.manifest = buildManifest({ plan, runId: `${plan.id}-${t0}`, startedAt: res.startedAt, runTag, profile: prof?.name, account, device: preflight?.device ?? (udid ? { udid, app: prof?.packageName ? { package: prof.packageName } : undefined } : undefined), preflight });
    traj.emit('manifest', res.manifest as unknown as Record<string, unknown>);
    traj.emit('plan', { planId: plan.id, issue: plan.issueRef, category: plan.category, surface: plan.surface, env: plan.env, draftHash: plan.provenance.draftHash, pattern: plan.provenance.pattern, coverage: plan.coverage });
    if (plan.contract) traj.emit('contract', plan.contract as unknown as Record<string, unknown>);
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
    head(res.account, res.device);
    // The conversation the run constructs in / reads (names only).
    if (res.manifest?.account) res.manifest.account.conversation = res.targets.find((t) => /conversation/.test(t.kind))?.chosen;
    if (NO_VERDICT.includes(res.conclusion)) res.failure = classifyFailure(res.conclusion, res.error ?? res.conclusionDetail, envAtFailure);
    if (plan.category !== 'feature') res.lead = leadOf(plan, res);
    if (res.manifest) await writeManifest(o.runDir, res.manifest).catch(() => {});
    stats.locateTiers = Object.fromEntries(Object.entries(locateTally).map(([k, v]) => [k, { n: v.n - (locate0[k]?.n ?? 0), ms: v.ms - (locate0[k]?.ms ?? 0) }]).filter(([, v]) => (v as { n: number }).n > 0));
    const out = finish(res, t0, stats, calls0);
    writeTrajectory(traj, out, opsOf());
    await traj.close({ runId: `${plan.id}-${t0}`, query: `Issue ${plan.issueRef} ${plan.title}`, startedAt: isoMs(t0), endedAt: isoMs(Date.now()), model: process.env.MIDSCENE_MODEL_NAME ?? '', account: res.account ?? '', output: { conclusion: out.conclusion, detail: out.conclusionDetail, stats: out.stats, coverage: out.coverage } });
    return out;
  };
  let opsOf: () => CoordOp[] = () => [];

  // ---- lease: account + slot of an endpoint (a phone for Android surfaces, this computer otherwise)
  const taskId = o.taskId ?? `run-${plan.id}-${t0}`;
  const tLease = Date.now();
  let lease: Lease | null = null;
  for (let i = 0; i < 30 && !lease; i++) {
    lease = o.pool.lease(taskId, { env: plan.env, surface: plan.surface, accountId: plan.account, devices: o.devices, device: onAndroid(plan.surface) ? o.udid : undefined });
    if (!lease) await sleep(2000);
  }
  if (!lease) {
    res.error = `no free ${plan.env} account${o.devices ? ' / endpoint slot' : ''} for ${plan.surface}`;
    return done();
  }
  const account = lease.accounts[0];
  res.account = account.id;
  const udid = lease.device?.kind === 'android' ? lease.device.udid : (o.udid ?? (onAndroid(plan.surface) ? account.boundDevice : undefined));
  res.device = onAndroid(plan.surface) ? udid : undefined;
  phase('lease', tLease);

  // ---- preflight (W2-2 §4.2): an unfit phone is 环境不合格 — nothing is launched or tapped. Web surfaces:
  // the minimal check — a browser starts and the account's signed-in session is valid.
  o.hooks?.phase('preflight');
  if (o.preflight !== false && ((onAndroid(plan.surface) && udid) || onPlaywright(plan.surface))) {
    const tPf = Date.now();
    // Ledger first (G6): the preflight may wake the screen and apply the environment's configuration items.
    if (udid && onAndroid(plan.surface)) o.hooks?.effect({ kind: 'setting', target: 'preflight', value: 'wake / stayon / taplus / keyboard (environment configuration items)' });
    if (onPlaywright(plan.surface)) {
      const w = await ensureWebSession(o.pool, account.id, plan.surface as PlaywrightSurface).catch((e) => ({ ok: false, error: (e as Error).message.split('\n')[0], reused: false, file: '' }));
      preflight = await preflightWeb({ sessionOk: w.ok, sessionDetail: w.ok ? `signed-in session ${w.reused ? 'valid (reused)' : 'renewed (logged in)'}` : `login failed: ${w.error}` });
    }
    if (udid && onAndroid(plan.surface)) {
      const pkg = loadProfile(profileKey(plan.surface, plan.env, udid))?.packageName ?? TEAMILY_PACKAGE;
      // An adb failure inside the preflight is the environment (device gone / unauthorized), not the tool.
      preflight = await preflightAndroid(udid, pkg, plan.surface).catch(async (e) => {
        const snap = await envSnapshot(udid, pkg).catch(() => ({ online: false }) as EnvSnapshot);
        const msg = (e as Error).message.split('\n')[0];
        const id = snap.online === false ? 'online' : 'adb';
        return { ok: false, ms: 0, items: [{ id, ok: false, detail: msg }], changes: [], reason: `${id}: ${snap.online === false ? `设备不在线（${msg.slice(0, 120)}）` : msg}` } satisfies PreflightResult;
      });
    }
    phase('preflight', tPf);
    const pf = preflight!;
    pf.ms = Date.now() - tPf;
    log(`preflight: ${pf.ok ? 'ok' : `NOT fit — ${pf.reason}`} (${pf.ms} ms${pf.changes.length ? `; changed: ${pf.changes.join('; ')}` : ''})`);
    if (!pf.ok) {
      res.conclusion = '环境不合格';
      res.conclusionDetail = `预检不合格：${pf.reason}`;
      o.pool.release(lease, o.devices);
      return done();
    }
  }
  head(account.id, udid);

  let sess: Session | undefined;
  let afr: AndroidFlightRecorder | undefined;
  let wfr: WebFlightRecorder | undefined;
  const flightDir = join(o.runDir, '.flight');
  try {
    // ---- session: profile + driver + flight recorder, launch once, sign in, home list, SKILL check
    if (onPlaywright(plan.surface)) wfr = new WebFlightRecorder(flightDir);
    if (onAndroid(plan.surface) && udid) afr = new AndroidFlightRecorder(udid, loadProfile(profileKey(plan.surface, plan.env, udid))?.packageName ?? TEAMILY_PACKAGE, flightDir);
    o.hooks?.phase('launch');
    sess = await openSession({ surface: plan.surface, env: plan.env, account: account.id, udid, pool: o.pool, headed: o.headed, profile: o.profile, onLog: afr?.onLog, onConsole: wfr?.onConsole, log });
    const s = sess;
    opsOf = () => s.d.ops;
    // Clean start (W2-2 §4.3): the App is cold-started, never resumed on a screen an earlier run left.
    if (plan.surface === 'android-app' && s.inner instanceof AndroidDriver) await s.inner.killApp();
    await afr?.start();
    await enterApp(s, {
      afterLaunch: async () => {
        if (s.web) await wfr!.start(s.web.context!, s.web.page!);
      },
      // Phones: the bottom bar looks the same on every tab — make sure the chat tab is the one showing.
      chatTab: plan.setup.some((a) => a.node?.name === 'teamily.openConversation'),
      staleShot: staleShotPath(o.runDir),
      healDir: o.runDir,
      onHeal: (h) => (res.healed ??= []).push(...h),
      onPhase: (name, ms) => (res.phases![name] = ms),
    });
    stats.launches++;

    const targets: Record<string, import('../drivers/types').Point> = {};
    const nodeCtx: NodeContext = {
      driver: s.d,
      profile: s.profile,
      targets,
      credentials: () => o.pool.backend.get(account.id),
      // prepare-only Nodes (validator keeps them out of the loop)
      locate: async (desc, texts, newest, textOnly) => (textOnly ? await locateText(s.inner, texts, newest) : await locate(s.inner, desc, { texts, newest, purpose: 'prep' }))?.point ?? null,
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
        o.hooks?.beforeAction(x, { round: s.d.round, step: s.d.step, label: s.d.label, target: (id) => res.targets.find((t) => t.id === id)?.chosen, budgetMs: x.type === 'idle' ? 120_000 + Number(x.value ?? 0) : undefined });
        return x.type === 'require' ? requireNow(c, x) : execAction(x, nodeCtx, s.profile, targets);
      },
      frames: [],
      setupOps: [],
      afr,
      wfr,
    };
    cRef = c;
    setModelPurpose('prep');
    nodeCtx.composerText = () => composerText(s.inner);
    const tPrep = Date.now();
    o.hooks?.phase('prepare');
    res.isolation = { cleanStart: [], teardown: [] };
    await prepare(c, async () => {
      res.isolation!.cleanStart = await cleanStart(c);
    });
    phase('prepare', tPrep);
    nodeCtx.composerText = undefined; // the loop reads no hierarchy
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
    await runLoop(c, { reviewIssue, correctPathOk });
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
    }
    if (err instanceof CancelledError) res.cancelled = true;
    o.hooks?.phase('finishing');
    res.error = (err as Error).message.split('\n')[0];
    log(`error: ${res.error}`);
    // The screen and the device state at the moment of the error (diagnosis: environment or tool).
    if (sess) await sess.d.screenshot().then((png) => writeFile(join(o.runDir, 'error.png'), png)).catch(() => {});
    if (udid && onAndroid(plan.surface)) envAtFailure = await envSnapshot(udid, sess?.profile.packageName ?? TEAMILY_PACKAGE).catch(() => undefined);
    if (cRef) await reset(cRef);
    return done();
  } finally {
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

/** Pure: where a check looks (report lead). */
export function checkLocation(k: TestPlan['checks'][number]): string {
  if (k.kind === 'text') {
    const s = k.scope ?? 'screen';
    if (s === 'composer') return '聊天页输入框（chat.composer 的文字）';
    if (s === 'quote-cards') return '聊天页引用块';
    if (s === 'screen') return '当前屏幕文字';
    if ('message' in s) return `聊天页本轮最新一条含「${s.message}」的消息气泡`;
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
  for (const h of r.healed ?? []) traj.emit('healed', { ...h });
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
  stats.modelCallsByPurpose = Object.fromEntries(Object.entries(modelCalls.byPurpose).map(([k, v]) => [k, v - (calls0.byPurpose[k] ?? 0)]).filter(([, v]) => (v as number) > 0));
  return res;
}

export const runDirFor = (planId: string) => resolve('midscene_run/issues', `${planId}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
