// Exploration tier (capability ②): one agent loop on a real phone / browser — after ref/artemis Flash (Apache-2.0,
// rewritten). Each step: screen snapshot (screenshot + numbered elements) → the vision model picks one action →
// risk rules (read-only by default) → pre-tap check → the action through the recording driver → the driver's
// event stream. Hard anomalies are findings at once; a problem the model reports is written as an incident and
// counts only after the evidence review. Same session, recorders, incident bundles and replay files as the pro
// tier (engine/plan). Ends when the agent reports done, at the step / time limits, or on cancel.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as llm from '../../core/model/llm';
import { modelCalls, setModelPurpose, visionConfigured, visionJson } from '../../core/model/llm';

const visionOutageNow = () => llm.visionOutage;
import { label, type ScreenNode } from '../../core/screen-index';
import { isoMs, openTrajectory } from '../../core/trajectory';
import { TEAMILY_PACKAGE } from '../../drivers/factory';
import { EXPLORE_LIMITS } from '../../platform/schema/test-plan';
import { type Anomaly, HARD_ANOMALIES, type Point, sleep } from '../../drivers/types';
import type { AccountPool, Lease } from '../../platform/accounts/account-pool';
import { type Env, onAndroid, onPlaywright, type Surface } from '../../platform/accounts/types';
import type { DevicePool } from '../../platform/device-pool';
import { CancelledError, type RunHooks } from '../../platform/lifecycle/runtime';
import type { TestPlan } from '../../platform/schema/test-plan';
import { leaseFor, preflightFor } from '../lease';
import { PreTapGuard } from '../pretap';
import { AndroidFlightRecorder } from '../recorder/android-recorder';
import { incidentDir, incidentKind, type IncidentKind, type ReplayFile, type RoundFrame, writeIncident } from '../recorder/bundle';
import { type EvidenceVerdict, reviewIncident } from '../recorder/evidence-review';
import { WebFlightRecorder } from '../recorder/web-recorder';
import { closeSession, enterApp, openBenchSession, openSession, packageOf, type Session } from '../session';
import { snapshot } from '../snapshot';
import { deadTap, detect, DETECT, DETECT_EXPECTED, type DetectHit, type DetectKind, newDetectState, type Observation } from '../detect';
import { type Box, decodePng } from '../../core/image';
import { classifyRisk, isSearchLabel, nearOwnContent, wasSearchBox } from './risk';
import { CandidateTracker } from './candidates';
import { type AgentAction, type AgentAnswer, BENCH_SYSTEM, fingerprint, historyText, loopHint, parseAnswer, planState, type StepRecord, SYSTEM, userPrompt, visibleElements } from './step';
import { scalePng } from '../recorder/evidence-review';

export type AgentMode = 'task' | 'explore';

export interface AgentOptions {
  goal: string;
  mode: AgentMode;
  surface: Surface;
  env: Env;
  /** Absent only in bench runs. */
  pool?: AccountPool;
  devices?: DevicePool;
  udid?: string;
  account?: string;
  writable?: boolean;
  /** Default and ceiling: EXPLORE_LIMITS (500 steps / 30 minutes, W2-5 N2). */
  maxSteps?: number;
  maxMinutes?: number;
  runDir: string;
  taskId?: string;
  hooks?: Partial<RunHooks>;
  /** Instructions the user added since the previous call (W2-5 §7.2); read at each step boundary. */
  inbox?: () => string[];
  /** Called after every step (the platform writes task progress from it). */
  onStep?: (r: StepRecord) => void;
  headed?: boolean;
  log?: (s: string) => void;
  /** Bench mode (AndroidWorld on an emulator, W2-5 P1): no lease / preflight / sign-in, nothing blocked,
   *  no findings; open_app and answer go to the bench service. */
  bench?: BenchLink;
}

export interface BenchLink {
  udid: string;
  act(a: { action_type: 'open_app'; app_name: string } | { action_type: 'answer'; text: string }): Promise<void>;
}

export interface Finding {
  n: number;
  /** hard = crash / ANR / app-exit / page-crash; reported = the agent's report_issue; detector = a deterministic
   *  detector (engine/detect.ts). Reported and detector findings count after the evidence review agrees. */
  source: 'hard' | 'reported' | 'detector';
  /** source detector: which one. */
  detector?: DetectKind;
  kind: IncidentKind;
  description: string;
  step: number;
  screen: string;
  incident: string;
  review?: EvidenceVerdict;
  /** Counted as a finding (hard anomalies always; reported ones when the review agrees). */
  counted: boolean;
  /** The steps that led here (coordinates + labels) — what an Issue draft is made from. */
  path: string[];
}

export interface AgentResult {
  schemaVersion: 1;
  kind: 'agent';
  goal: string;
  mode: AgentMode;
  surface: Surface;
  env: Env;
  writable: boolean;
  account?: string;
  device?: string;
  startedAt: string;
  finishedAt: string;
  status: 'completed' | 'failed' | 'limit' | 'cancelled' | 'env-unfit' | 'error';
  summary: string;
  plan?: string;
  findings: Finding[];
  blocked: { step: number; action: string; reason: string }[];
  coverage: { screens: number; actions: number; byScreen: Record<string, number> };
  usage: { steps: number; seconds: number; modelCalls: number };
  steps: StepRecord[];
  /** SKILL candidates written to skill-candidates.json (W2-5 §7.3). */
  candidates?: { count: number; file: string };
  /** Instructions added during the run, with the step they arrived before. */
  instructions?: { step: number; text: string }[];
  runDir: string;
  error?: string;
}

const MODEL_TIMEOUT_MS = 180_000;
/** Pure: the limits of one run — the requested ones, never above EXPLORE_LIMITS. */
export function agentLimits(o: { maxSteps?: number; maxMinutes?: number }): { maxSteps: number; maxMinutes: number } {
  return { maxSteps: Math.min(o.maxSteps ?? EXPLORE_LIMITS.maxSteps, EXPLORE_LIMITS.maxSteps), maxMinutes: Math.min(o.maxMinutes ?? EXPLORE_LIMITS.maxMinutes, EXPLORE_LIMITS.maxMinutes) };
}
/** Screenshot width sent to the model (tokens); taps stay in the element coordinate space. */
const SHOT_WIDTH = 720;
/** Step thumbnails for the task page. */
const THUMB_WIDTH = 240;

/** The minimal plan an incident bundle carries for a exploration-tier run (no Issue behind it). */
function planStub(o: AgentOptions, id: string): TestPlan {
  return {
    id,
    issueRef: 'explore',
    title: o.goal.slice(0, 120),
    category: 'bug-intermittent',
    surface: o.surface,
    issueSurfaces: [o.surface],
    env: o.env,
    launch: 'once',
    targets: [],
    setup: [],
    prepare: [],
    actions: [],
    checks: [],
    afterCheck: [],
    limits: { maxSteps: EXPLORE_LIMITS.maxSteps, maxMinutes: EXPLORE_LIMITS.maxMinutes, maxIntervalMs: 1000 },
    verdictRule: { anyHit: true },
    provenance: { generatedBy: 'model', skillVersion: '-' },
  } as TestPlan;
}

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const log = o.log ?? ((s: string) => console.log(`[agent] ${s}`));
  const t0 = Date.now();
  const id = `agent-${o.mode}-${t0}`;
  await mkdir(join(o.runDir, 'steps'), { recursive: true });
  const traj = openTrajectory(join(o.runDir, 'trajectory.jsonl'));
  const res: AgentResult = { schemaVersion: 1, kind: 'agent', goal: o.goal, mode: o.mode, surface: o.surface, env: o.env, writable: !!o.writable, startedAt: new Date(t0).toISOString(), finishedAt: '', status: 'error', summary: '', findings: [], blocked: [], coverage: { screens: 0, actions: 0, byScreen: {} }, usage: { steps: 0, seconds: 0, modelCalls: 0 }, steps: [], runDir: o.runDir };
  const calls0 = modelCalls.vision + modelCalls.text;
  const { maxSteps, maxMinutes } = agentLimits(o);
  const deadline = t0 + maxMinutes * 60_000;
  const tried = new Map<string, Set<string>>();
  // SKILL candidates (W2-5 §7.3, N6): elements seen again and again with the same text — a list for people.
  const candidates = new CandidateTracker();
  const ownNames = o.pool?.ownContent(o.env) ?? [];
  const finish = async (): Promise<AgentResult> => {
    res.finishedAt = new Date().toISOString();
    res.usage = { steps: res.steps.length, seconds: Math.round((Date.now() - t0) / 1000), modelCalls: modelCalls.vision + modelCalls.text - calls0 };
    res.coverage = { screens: tried.size, actions: [...tried.values()].reduce((n, s) => n + s.size, 0), byScreen: Object.fromEntries([...tried].map(([k, v]) => [k, v.size])) };
    if (!o.bench) {
      const list = candidates.list();
      res.candidates = { count: list.length, file: join(o.runDir, 'skill-candidates.json') };
      await writeFile(res.candidates.file, JSON.stringify({ schemaVersion: 1, goal: o.goal, surface: o.surface, env: o.env, note: '候选元素：人工审核后再进 SKILL 标定，不会自动写入 profile（W2-5 N6）', candidates: list }, null, 2)).catch(() => {});
    }
    await writeFile(join(o.runDir, 'result.json'), JSON.stringify(res, null, 2));
    await writeFile(join(o.runDir, 'report.md'), agentMarkdown(res));
    traj.emit('verdict', { conclusion: res.status, detail: res.summary, findings: res.findings.filter((f) => f.counted).length });
    await traj.close({ runId: id, query: o.goal, startedAt: isoMs(t0), endedAt: isoMs(Date.now()), model: process.env.MIDSCENE_MODEL_NAME ?? '', account: res.account ?? '', output: { status: res.status, findings: res.findings.length, coverage: res.coverage } }).catch(() => {});
    return res;
  };
  if (!visionConfigured()) {
    res.error = 'vision model not configured (MIDSCENE_MODEL_*)';
    res.summary = '没有视觉模型配置，探索档无法运行';
    return finish();
  }

  // ---- lease + preflight (shared with the quick tier); bench runs use their emulator as it is
  const bench = o.bench;
  let lease: Lease | undefined;
  let accountId = 'bench';
  let udid: string | undefined = bench?.udid;
  if (!bench) {
    if (!o.pool) throw new Error('runAgent: an account pool is required outside bench mode');
    const leased = await leaseFor({ pool: o.pool, devices: o.devices, env: o.env, surface: o.surface, accountId: o.account, udid: o.udid, taskId: o.taskId ?? id, hooks: o.hooks, log });
    if (leased.error !== undefined) {
      res.error = leased.error;
      res.summary = leased.error;
      return finish();
    }
    lease = leased.lease;
    accountId = leased.account.id;
    udid = leased.udid;
    traj.emit('lease', { account: accountId, device: udid, surface: o.surface });
    o.hooks?.phase?.('preflight');
    const pf = await preflightFor({ pool: o.pool, surface: o.surface, hooks: o.hooks, log }, accountId, udid);
    if (pf && !pf.ok) {
      res.status = 'env-unfit';
      res.summary = `环境不合格：${pf.reason}`;
      o.pool.release(lease, o.devices);
      return finish();
    }
  }
  res.account = accountId;
  res.device = onAndroid(o.surface) ? udid : undefined;

  let sess: Session | undefined;
  let afr: AndroidFlightRecorder | undefined;
  let wfr: WebFlightRecorder | undefined;
  const flightDir = join(o.runDir, '.flight');
  try {
    if (!bench && onPlaywright(o.surface)) wfr = new WebFlightRecorder(flightDir);
    if (!bench && onAndroid(o.surface) && udid) afr = new AndroidFlightRecorder(udid, packageOf(o.surface) ?? TEAMILY_PACKAGE, flightDir);
    o.hooks?.phase?.('launch');
    sess = bench ? await openBenchSession(bench.udid, log) : await openSession({ surface: o.surface, env: o.env, account: accountId, udid, pool: o.pool!, headed: o.headed, onLog: afr?.onLog, onConsole: wfr?.onConsole, log });
    const s = sess;
    const guard = new PreTapGuard(s.inner, { dir: o.runDir, log, ...(bench ? { pkg: '' } : {}) });
    await afr?.start();
    if (!bench) await enterApp(s, { afterLaunch: async () => void (s.web && (await wfr!.start(s.web.context!, s.web.page!))) });
    o.hooks?.phase?.('loop');
    setModelPurpose('agent');
    let plan: string | undefined;
    let feedback: string | undefined;
    const path: string[] = [];

    const incident = async (kind: IncidentKind, detail: string, step: number): Promise<string> => {
      const n = res.findings.length + 1;
      const dir = incidentDir(o.runDir, n, kind);
      const at = Date.now();
      const cap = afr ? await afr.capture(dir, at) : wfr && s.web ? await wfr.capture(s.web.context!, dir, at) : undefined;
      const replay: ReplayFile = { format: 'coord-v1', skillVersion: s.profile.skillVersion, surface: o.surface, profile: s.profile.name, env: o.env, url: s.web ? o.pool?.webUrl(o.env) : undefined, packageName: s.profile.packageName, account: accountId, device: udid, launch: 'once', category: 'bug-intermittent', verdictRule: { anyHit: true }, checks: [], targets: [], setupOps: [], rounds: [{ round: 1, ops: s.d.ops.slice(-80) }], incidentRound: 1 };
      await writeIncident({ runDir: o.runDir, n, kind, at, detail, plan: planStub(o, id), step, round: 1, action: s.d.label, env: { account: accountId, device: udid, ...(cap && 'state' in cap ? cap.state : {}) }, ops: s.d.ops, frames: recentFrames.slice(), replay, videos: cap && 'videos' in cap ? cap.videos : undefined, traces: cap && 'traces' in cap ? cap.traces : undefined, logFrom: cap?.logFrom ?? at - 180_000, logTo: cap?.logTo ?? at, clockOffsetMs: afr?.clockOffsetMs, dir });
      return dir;
    };

    const searchBoxes: Box[] = [];
    // The last screens seen, full size: an incident bundle carries them, so the evidence review has frames where
    // there is no recording (Web: a trace only).
    const recentFrames: RoundFrame[] = [];
    // Deterministic detectors (W2-5 §6): on the observation each step takes anyway; not in bench runs.
    const dst = newDetectState();
    const seenHits = new Set<string>();
    let lastTap: { key: string; obs: Observation; target: { text: string; box: Box }; at: number } | undefined;
    const detectorFinding = async (h: DetectHit, step: number, screen: string): Promise<string> => {
      const dir = await incident('visual-anomaly', h.description, step);
      const review = await reviewIncident(dir, { id: 'explore', summary: o.goal, expected: DETECT_EXPECTED[h.kind], actual: h.description }, { log }).catch(() => undefined);
      const counted = review?.verdict === 'consistent';
      res.findings.push({ n: res.findings.length + 1, source: 'detector', detector: h.kind, kind: 'visual-anomaly', description: h.description, step, screen, incident: dir, review: review?.verdict, counted, path: [...path] });
      traj.emit('finding', { step, description: h.description, detector: h.kind, review: review?.verdict, counted });
      return `detector ${h.kind}: ${h.description} (evidence review: ${review?.verdict ?? 'unverified'})`;
    };

    for (let step = 1; ; step++) {
      if (o.hooks?.shouldStop?.()) throw new CancelledError();
      if (step > maxSteps || Date.now() > deadline) {
        res.status = 'limit';
        res.summary = step > maxSteps ? `到达步数上限 ${maxSteps}` : `到达时长上限 ${Math.round((deadline - t0) / 60_000)} 分钟`;
        break;
      }
      for (const text of o.inbox?.() ?? []) {
        (res.instructions ??= []).push({ step, text });
        traj.emit('inject', { step, text });
        log(`instruction before step ${step}: ${text}`);
      }
      s.d.step = step;
      s.d.round = 1;
      // Fault injection for acceptance runs (W2-5 DoD 2): the browser goes offline at this step — network level,
      // the page's code is not touched (B1). Never set in normal use.
      if (s.web?.context && Number(process.env.AUTOTEST_FAULT_OFFLINE_STEP) === step) {
        await s.web.context.setOffline(true);
        log(`fault injection: browser offline from step ${step}`);
      }
      // A tap that may have done nothing is judged ≥ 3 s after it (no-response detector).
      if (lastTap && Date.now() - lastTap.at < DETECT.deadTapMs) await sleep(DETECT.deadTapMs - (Date.now() - lastTap.at));
      // Bench: whatever app is in front (the driver is bound to the launcher); otherwise the app under test.
      const snap = await snapshot(s.inner, { keepPng: true, stableMaxMs: 1500, ...(bench ? { pkg: '' } : { texts: true }) }).catch(() => undefined);
      const nodes: ScreenNode[] = snap?.nodes ?? [];
      const els = visibleElements(nodes);
      const screen = fingerprint(nodes);
      for (const n of els) if (isSearchLabel(label(n)) && !searchBoxes.some((b) => b.join() === n.box.join())) searchBoxes.push(n.box);
      if (searchBoxes.length > 20) searchBoxes.splice(0, searchBoxes.length - 20);
      if (!bench) candidates.see(step, screen, els);
      const triedHere = tried.get(screen) ?? new Set<string>();
      tried.set(screen, triedHere);
      const png = snap?.png ?? (await s.inner.screenshot());
      if (!bench) {
        recentFrames.push({ round: 1, step, at: Date.now(), hash: '', png });
        if (recentFrames.length > 3) recentFrames.shift();
      }
      const shot = scalePng(png, SHOT_WIDTH);
      const vp = s.profile.viewport.width ? s.profile.viewport : { width: snap?.width ?? 0, height: snap?.height ?? 0 };
      let obs: Observation | undefined;
      if (!bench) {
        const img = (() => {
          try {
            return decodePng(png);
          } catch {
            return undefined;
          }
        })();
        obs = { at: Date.now(), img, nodes, texts: snap?.texts, width: snap?.width ?? img?.width ?? 0, height: snap?.height ?? img?.height ?? 0 };
        const hits = detect(obs, dst);
        const dead = lastTap && deadTap(lastTap.key, lastTap.obs, obs, dst, lastTap.target);
        if (dead) hits.push(dead);
        lastTap = undefined;
        const notes: string[] = [];
        for (const h of hits) {
          const key = `${screen}:${h.kind}:${h.text ?? ''}`;
          if (seenHits.has(key)) continue;
          seenHits.add(key);
          notes.push(await detectorFinding(h, step, screen));
        }
        if (notes.length) feedback = `${feedback ?? 'ok'}. ${notes.join('; ')}`;
      }
      const prompt = userPrompt({ goal: o.goal, mode: o.mode, plan, history: historyText(res.steps), screen, els, tried: [...triedHere], feedback, size: vp, instructions: res.instructions?.map((x) => x.text) });
      let ans: AgentAnswer | undefined;
      const system = bench ? BENCH_SYSTEM : SYSTEM(!!o.writable, ownNames);
      for (let k = 0; k < 2 && !ans; k++) ans = parseAnswer(await visionJson(system, [prompt, { label: 'Screenshot (scaled; use the element coordinates for taps)', png: shot }], MODEL_TIMEOUT_MS).catch(() => undefined), !!bench);
      if (!ans) {
        // A service that stays busy is a tool failure, not the agent's: no conclusion from this run.
        const down = visionOutageNow();
        res.status = down ? 'error' : 'failed';
        res.summary = down ? `模型服务不可用：${down}` : '模型连续两次没有给出可用的动作';
        if (down) res.error = `vision service unavailable: ${down}`;
        break;
      }
      plan = ans.plan ?? plan;
      res.plan = plan;
      const thought = ans.thought.slice(0, 300);
      const thumb = `steps/${String(step).padStart(4, '0')}.png`;
      await writeFile(join(o.runDir, thumb), scalePng(png, THUMB_WIDTH)).catch(() => {});
      const record = (result: string) => {
        const r: StepRecord = { step, screen, action: act, result, thought, thumb };
        res.steps.push(r);
        o.onStep?.(r);
      };
      const a = ans.action;
      const burst = [a, ...(ans.then ?? [])];
      const act = burst.map((x) => describe(x, els)).join(' → ');
      traj.emit('agent.step', { step, screen, thought, action: act, thumb });
      if (a.type === 'done') {
        res.status = a.status;
        res.summary = a.summary;
        record(`done (${a.status})`);
        break;
      }
      if (a.type === 'report_issue') {
        const dir = await incident('visual-anomaly', a.description, step);
        const review = await reviewIncident(dir, { id: 'explore', summary: o.goal, expected: '应用可以正常使用：没有报错、白屏、卡住或显示错乱', actual: a.description }, { log }).catch(() => undefined);
        const counted = review?.verdict === 'consistent';
        res.findings.push({ n: res.findings.length + 1, source: 'reported', kind: 'visual-anomaly', description: a.description, step, screen, incident: dir, review: review?.verdict, counted, path: [...path] });
        traj.emit('finding', { step, description: a.description, review: review?.verdict, counted });
        feedback = counted ? 'issue recorded and confirmed by the evidence review' : `issue recorded; the evidence review says ${review?.verdict ?? 'unverified'} — look closer or move on`;
        record(`issue ${counted ? 'confirmed' : review?.verdict ?? 'unverified'}`);
        continue;
      }
      // The action, or a short burst of them on this screen (Artemis Flash click_sequence): each passes the risk
      // rules (before anything touches the app) and the pre-tap check; the burst stops at the first that does not.
      const outs: string[] = [];
      let blocked: string | undefined;
      for (const [i, b] of burst.entries()) {
        const bAct = describe(b, els);
        const el = 'target' in b && b.target !== undefined ? els[b.target - 1] : undefined;
        const lbl = el ? label(el) : 'description' in b ? (b.description ?? '') : '';
        const y = el ? el.center.y : 'y' in b ? b.y : undefined;
        const own = y !== undefined && nearOwnContent(y, nodes.map((n) => ({ label: label(n), y: n.center.y })), ownNames, vp.height);
        const searchBox = b.type === 'type' && !!el && wasSearchBox(el.box, searchBoxes);
        const risk = classifyRisk({ type: b.type, label: lbl, text: b.type === 'type' ? b.text : undefined, free: !el }, !!o.writable, { ownContent: own, bench: !!bench, searchBox });
        if (risk.blocked) {
          res.blocked.push({ step, action: bAct, reason: risk.reason });
          traj.emit('blocked', { step, action: bAct, reason: risk.reason });
          blocked = risk.reason;
          break;
        }
        if (i) await sleep(400);
        const out = await perform(s, guard, b, el, vp, bench).catch((e) => `error: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
        if (obs && burst.length === 1 && el?.clickable && b.type === 'tap' && out === 'ok') lastTap = { key: actionKey(b, el), obs, target: { text: label(el), box: el.box }, at: Date.now() };
        triedHere.add(actionKey(b, el));
        path.push(bAct);
        outs.push(out);
        if (out !== 'ok' && !out.startsWith('answer')) break;
      }
      if (blocked && !outs.length) {
        feedback = `BLOCKED: ${blocked}`;
        record(`blocked: ${blocked}`);
        continue;
      }
      feedback = burst.length === 1 ? outs[0] : `${outs.map((r, i) => `#${i + 1} ${r}`).join('; ')}${outs.length < burst.length ? ` — stopped after ${outs.length} of ${burst.length}${blocked ? ` (BLOCKED: ${blocked})` : ''}` : ''}`;
      await sleep(900);
      // Bench runs judge nothing: the driver is bound to no app under test.
      const hard = bench ? [] : s.d.drainAnomalies().filter((x: Anomaly) => HARD_ANOMALIES.includes(x.kind));
      if (hard.length) {
        const x = hard[0];
        const kind = incidentKind(x.kind);
        const dir = await incident(kind, x.detail, step);
        res.findings.push({ n: res.findings.length + 1, source: 'hard', kind, description: `${x.kind}: ${x.detail}`, step, screen, incident: dir, counted: true, path: [...path] });
        traj.emit('finding', { step, description: x.detail, kind, counted: true });
        feedback = `the app ${x.kind === 'page-crash' ? 'page crashed' : x.kind === 'app-exit' ? 'exited' : x.kind} — it was relaunched`;
        await s.d.launch().catch(() => {});
        await sleep(2500);
        lastTap = undefined;
      }
      record(feedback ?? 'ok');
      const loop = loopHint(res.steps);
      if (loop) feedback = `${feedback ?? 'ok'}. ${loop}`;
    }
  } catch (e) {
    if (e instanceof CancelledError) {
      res.status = 'cancelled';
      res.summary = '已取消';
    } else {
      res.status = 'error';
      res.error = (e as Error).message.split('\n')[0];
      res.summary = `执行出错：${res.error}`;
      log(`error: ${res.error}`);
    }
  } finally {
    setModelPurpose('other');
    await afr?.stop().catch(() => {});
    await closeSession(sess);
    if (lease) o.pool!.release(lease, o.devices);
  }
  return finish();
}

function describe(a: AgentAction, els: ScreenNode[]): string {
  const t = (n?: number) => (n !== undefined && els[n - 1] ? `#${n} "${label(els[n - 1]).slice(0, 30)}"` : '');
  switch (a.type) {
    case 'tap':
    case 'longPress':
      return `${a.type} ${a.target !== undefined ? t(a.target) : `(${a.x},${a.y}) ${a.description ?? ''}`}`.trim();
    case 'type':
      return `type ${t(a.target)} "${a.text.slice(0, 40)}"${a.clear ? ' (clear)' : ''}`;
    case 'drag':
      return `drag (${a.x1},${a.y1})→(${a.x2},${a.y2})`;
    case 'swipe':
      return `swipe ${a.direction}`;
    case 'wait':
      return `wait ${a.ms}ms`;
    case 'done':
      return `done ${a.status}`;
    case 'report_issue':
      return `report_issue "${a.description.slice(0, 60)}"`;
    case 'open_app':
      return `open_app "${a.app}"`;
    case 'answer':
      return `answer "${a.text.slice(0, 60)}"`;
    default:
      return a.type;
  }
}

const actionKey = (a: AgentAction, el?: ScreenNode) => `${a.type}${el ? `:${label(el).slice(0, 20)}` : 'direction' in a ? `:${a.direction}` : ''}`;

/** Run one action through the recording driver; the pre-tap check guards taps on listed elements. */
async function perform(s: Session, guard: PreTapGuard, a: AgentAction, el: ScreenNode | undefined, vp: { width: number; height: number }, bench?: BenchLink): Promise<string> {
  const d = s.d;
  d.label = a.type;
  const pointOf = async (purpose: string): Promise<Point | string> => {
    if (el) {
      const r = await guard.check(el.center, { purpose, text: label(el) || undefined, rid: el.rid || undefined, box: el.box });
      if (r.kind !== 'pass' && r.kind !== 'corrected' && r.kind !== 'uncertain') return `pre-tap check: target ${r.kind} (${r.detail}) — not tapped`;
      return r.point;
    }
    if ('x' in a && a.x !== undefined && 'y' in a && a.y !== undefined) return { x: a.x, y: a.y };
    return 'no target';
  };
  switch (a.type) {
    case 'tap':
    case 'longPress': {
      const p = await pointOf(a.type);
      if (typeof p === 'string') return p;
      if (a.type === 'tap') await d.tap(p);
      else await d.longPress(p);
      return 'ok';
    }
    case 'type': {
      if (el) {
        const p = await pointOf('focus input');
        if (typeof p === 'string') return p;
        await d.tap(p);
        await sleep(400);
      }
      if (a.clear) {
        await d.key('selectall');
        await d.key('del');
      }
      await d.type(a.text);
      return 'ok';
    }
    case 'drag':
      await d.swipe({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, 600);
      return 'ok';
    case 'swipe': {
      // A swipe started on the soft keyboard glide-types a word into the focused field (2026-11-03 bench run:
      // "Gonzalez" became "Gonzalez By"): close the keyboard first, as a user would.
      if (await d.keyboardShown()) {
        await d.back();
        await sleep(400);
      }
      // "up" = the content moves up (more below comes into view): the finger goes from lower to upper.
      const cx = Math.round(vp.width / 2);
      const cy = Math.round(vp.height / 2);
      const h = Math.round(vp.height * 0.25);
      const w = Math.round(vp.width * 0.3);
      const from = { up: { x: cx, y: cy + h }, down: { x: cx, y: cy - h }, left: { x: cx + w, y: cy }, right: { x: cx - w, y: cy } }[a.direction];
      const to = { up: { x: cx, y: cy - h }, down: { x: cx, y: cy + h }, left: { x: cx - w, y: cy }, right: { x: cx + w, y: cy } }[a.direction];
      await d.swipe(from, to, 350);
      return 'ok';
    }
    case 'back':
      await d.back();
      return 'ok';
    case 'launch':
      await d.launch();
      return 'ok';
    case 'wait':
      await sleep(a.ms);
      return 'ok';
    case 'home':
      await d.key('home');
      return 'ok';
    case 'enter':
      await d.key('enter');
      return 'ok';
    case 'open_app':
      await bench!.act({ action_type: 'open_app', app_name: a.app });
      await sleep(1500);
      return 'ok';
    case 'answer':
      await bench!.act({ action_type: 'answer', text: a.text });
      return 'answer recorded — finish with done';
    default:
      return 'ok';
  }
}

/** How a finding was found, for people. */
export const FINDING_SOURCE: Record<Finding['source'], string> = { hard: '硬异常', reported: '模型报告', detector: '确定性判定' };

export function agentMarkdown(r: AgentResult): string {
  const counted = r.findings.filter((f) => f.counted);
  const st: Record<AgentResult['status'], string> = { completed: '完成', failed: '未能完成', limit: '到达上限', cancelled: '已取消', 'env-unfit': '环境不合格', error: '执行出错' };
  const ps = planState(r.plan);
  return [
    `# ${r.mode === 'explore' ? '探索' : '自然语言任务'}：${r.goal}`,
    '',
    `- 结果：**${st[r.status]}** — ${r.summary || '-'}`,
    `- 发现：${counted.length ? `${counted.length} 个（见下）` : `没有发现问题（覆盖 ${r.coverage.screens} 个界面、${r.coverage.actions} 个动作，拦截 ${r.blocked.length} 次）`}`,
    `- 执行端：${r.surface}（${r.env}）；账号 ${r.account ?? '-'}；${r.writable ? '可写' : '只读'}`,
    `- 用量：${r.usage.steps} 步，${r.usage.seconds} 秒，模型调用 ${r.usage.modelCalls} 次`,
    r.plan ? `- 计划：完成 ${ps.done}，未完成 ${ps.todo}，失败 ${ps.failed}` : '',
    '',
    ...(r.findings.length ? ['## 发现', '', ...r.findings.map((f) => `- #${f.n} ${f.counted ? '✅' : '⚠ 未计入'} ${FINDING_SOURCE[f.source]}（${f.detector ?? f.kind}）：${f.description}${f.review ? `；证据复核：${f.review}` : ''} — 第 ${f.step} 步，现场包 \`${f.incident}\``), ''] : []),
    ...(r.blocked.length ? ['## 拦截的动作', '', ...r.blocked.map((b) => `- 第 ${b.step} 步 ${b.action}：${b.reason}`), ''] : []),
    ...(r.plan ? ['## 计划（模型维护）', '', r.plan, ''] : []),
    '## 步骤',
    '',
    ...r.steps.map((x) => `- #${x.step} [${x.screen}] ${x.action} → ${x.result}`),
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
