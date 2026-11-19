// Exploration tier (capability ②): one agent loop on a real phone / browser — after ref/artemis Flash (Apache-2.0,
// rewritten). Each step: screen snapshot (screenshot + numbered elements) → the vision model picks one action →
// risk rules (read-only by default) → pre-tap check → the action through the recording driver → the driver's
// event stream. Hard anomalies are findings at once; a problem the model reports is written as an incident and
// counts only after the evidence review. Same session, recorders, incident bundles and replay files as the pro
// tier (engine/plan). Ends when the agent reports done (a task's completion passes the final review first), at
// the step / time limits, or on cancel.
// W3-3 (§8.6): an unusable answer is sent back with its reason, then costs a turn instead of ending the run (F2,
// F7); coordinates are 0–1000 (F3); typed text is read back from the field (F9); execution incidents and "the
// screen did not change" are told to the model (F7); notes (F5) and the full ledger with search (F8); final
// review of a task's completion (F6).
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as llm from '../../core/model/llm';
import { modelCall } from '../../core/context/assemble';
import { modelCalls, setModelPurpose, type Usage, visionConfigured } from '../../core/model/llm';
import { useCallLogs } from '../../core/context/logs';

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
import { type Box, decodePng, dHash, downscale, type Rgba } from '../../core/image';
import { classifyRisk, isSearchLabel, nearOwnContent, wasSearchBox } from './risk';
import { CandidateTracker } from './candidates';
import { type AgentAction, type AgentAnswer, BENCH_SYSTEM, elementList, fingerprint, loopHint, planState, readAnswer, type StepRecord, SYSTEM, type TypeAt, userPrompt, visibleElements } from './step';
import { historyText, ledgerLine, newScreenText, searchHistory } from './history';
import { Notes } from './notes';
import { categoryOf, Incidents, ScreenMemory, screenChanged } from './incident';
import { failureKey, feedbackBlock, passes, revertPlan, runCheck } from './checker';
import { toPx } from './coords';
import { scalePng } from '../recorder/evidence-review';
import { basename } from 'node:path';
import { type PageMatch, pageOf, startPageRecording, UNKNOWN_PAGE } from '../pages';
import { activeExpectations, type Expectation, expectationBlocks, type ExpectationOutcome, outcomeOf, readExpectations, readVerify } from '../explore/expectations';
import { knownBlock, knownPath, type KnownIssue, matchKnown, normText as knownText, readKnown, type TriageVerdict, updateKnown } from '../explore/known';
import { FINDING_SOURCE, findingKey, findingState, judgeFinding } from '../explore/judge';
import { addStats, type Lesson, lessonBlock, lessonsForStep, readLessons, type StepContext, suppressingLesson } from '../../platform/memory/lessons';
import { actionType } from '../../platform/memory/replay';
import { type MemoryClient, type MemoryMessage, memoryClient, memoryUser } from '../../core/memory/client';
export { FINDING_SOURCE };

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
  /** W3-4 exploration judgment: the checklist (explore mode) and the known-issues file. Default: the project's
   *  platform/explore files; false = none (bench runs never judge). */
  judge?: { expectations: Expectation[]; knownFile: string } | false;
  /** W3-5 lessons and the memory service: default on (bench runs never, D16); false = the "不用记忆" switch, or
   *  a given set (tests: lessons + a client). */
  memory?: false | { lessons: Lesson[]; client?: MemoryClient };
}

export interface BenchLink {
  udid: string;
  act(a: { action_type: 'open_app'; app_name: string } | { action_type: 'answer'; text: string }): Promise<void>;
}

export interface Finding {
  n: number;
  /** hard = crash / ANR / app-exit / page-crash; reported = the agent's report_issue; detector = a deterministic
   *  detector (engine/detect.ts); expectation = a checklist entry the screen contradicts (W3-4 §8.5 ①); human = a
   *  person marked the step 「这是问题」 (②). Reported, detector and expectation findings count after the evidence
   *  review agrees. */
  source: 'hard' | 'reported' | 'detector' | 'expectation' | 'human';
  /** source detector: which one. */
  detector?: DetectKind;
  /** source detector: the node text it is about (the known-issue key uses it). */
  text?: string;
  /** The page it was found on (engine/pages.ts; W3-4). */
  page?: string;
  /** source expectation: the entry, verbatim. */
  expectation?: { id: string; trigger: string; expect: string };
  /** The known issue it is (W3-4 §8.5 ④); isNew = first seen in this run. */
  known?: { id: string; count: number; isNew: boolean };
  /** Why a finding does not count although the review agreed: D10, or a known issue people dismissed. */
  excluded?: string;
  /** W3-5: the lesson that made it not count (L2). */
  lesson?: string;
  /** A person's triage on the result page (§8.5 ②). */
  triage?: { verdict: TriageVerdict; note?: string; at: string };
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
  /** checkCalls: final-review model calls, counted apart from the agent's (W3-3 §8.6.5). */
  usage: { steps: number; seconds: number; modelCalls: number; checkCalls?: number; tokens?: Usage };
  steps: StepRecord[];
  /** SKILL candidates written to skill-candidates.json (W2-5 §7.3). */
  candidates?: { count: number; file: string };
  /** Instructions added during the run, with the step they arrived before. */
  instructions?: { step: number; text: string }[];
  /** Final reviews of a reported completion (W3-3 F6). */
  checks?: { step: number; passed: boolean; failed: string[]; error?: string }[];
  /** Turns without a usable answer (W3-3 F7), and typed text that never reached its field (F9). */
  unusable?: number;
  inputNotCommitted?: number;
  /** Notes the agent wrote (W3-3 F5), by key. */
  notes?: Record<string, string>;
  /** The checklist entries the run carried and what came of each (W3-4 §8.5 ①; explore mode). */
  expectations?: ExpectationOutcome[];
  /** W3-5: lessons put into prompts / applied in judging, and the memory service's state for this run. */
  memory?: { off?: boolean; injected: string[]; applied: string[]; service: 'ok' | 'down' | 'off'; l0?: boolean };
  runDir: string;
  error?: string;
}

const MODEL_TIMEOUT_MS = 180_000;
/** Pre-tap match score above which a target that moved far is tapped where it is now. */
const SHIFT_RETARGET_SCORE = 0.9;
/** Pure: the limits of one run — the requested ones, never above EXPLORE_LIMITS. */
export function agentLimits(o: { maxSteps?: number; maxMinutes?: number }): { maxSteps: number; maxMinutes: number } {
  return { maxSteps: Math.min(o.maxSteps ?? EXPLORE_LIMITS.maxSteps, EXPLORE_LIMITS.maxSteps), maxMinutes: Math.min(o.maxMinutes ?? EXPLORE_LIMITS.maxMinutes, EXPLORE_LIMITS.maxMinutes) };
}
/** Screenshot width sent to the model (tokens); coordinates are 0–1000, so the scale does not matter (F3). */
const SHOT_WIDTH = 720;
/** Step thumbnails for the task page. */
const THUMB_WIDTH = 240;
/** Width of the frames compared for "did the screen change" (F7). */
const COMPARE_WIDTH = 270;
/** Ledger lines the final review sees (Artemis: the last 60 steps). */
const CHECK_LEDGER = 60;

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
    baseline: [],
    prepareChecks: [],
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
  const endCallLogs = useCallLogs(o.runDir);
  const res: AgentResult = { schemaVersion: 1, kind: 'agent', goal: o.goal, mode: o.mode, surface: o.surface, env: o.env, writable: !!o.writable, startedAt: new Date(t0).toISOString(), finishedAt: '', status: 'error', summary: '', findings: [], blocked: [], coverage: { screens: 0, actions: 0, byScreen: {} }, usage: { steps: 0, seconds: 0, modelCalls: 0 }, steps: [], runDir: o.runDir };
  const calls0 = modelCalls.vision + modelCalls.text;
  const tokens0 = { ...modelCalls.tokens };
  let checkCalls = 0;
  const { maxSteps, maxMinutes } = agentLimits(o);
  const deadline = t0 + maxMinutes * 60_000;
  const tried = new Map<string, Set<string>>();
  // SKILL candidates (W2-5 §7.3, N6): elements seen again and again with the same text — a list for people.
  const candidates = new CandidateTracker();
  const ownNames = o.pool?.ownContent(o.env) ?? [];
  const notes = new Notes(join(o.runDir, 'notes'));
  // W3-4: the checklist (explore mode) and the known issues across runs; bench runs judge nothing.
  const judging = !o.bench && o.judge !== false;
  const knownFile = o.judge ? o.judge.knownFile : knownPath();
  const expectations = judging && o.mode === 'explore' ? activeExpectations(o.judge ? o.judge.expectations : readExpectations(), !!o.writable) : [];
  const outcomes = new Map<string, ExpectationOutcome>(expectations.map((e) => [e.id, { id: e.id, page: e.page, trigger: e.trigger, expect: e.expect, source: e.source, result: '未核对', checks: [] }]));
  let known: KnownIssue[] = judging ? readKnown(knownFile) : [];
  const runKey = o.taskId ?? basename(o.runDir);
  // W3-5: the repository's lessons (deterministic path) and the memory service (search, L0). Off for bench runs
  // (D16: lessons learnt on the same tasks would leak answers) and with the "不用记忆" switch.
  const memOn = !o.bench && o.memory !== false;
  const lessons = memOn ? (o.memory ? o.memory.lessons : readLessons()).filter((l) => l.status === 'active') : [];
  const mem = memOn ? ((o.memory && o.memory.client) || memoryClient()) : undefined;
  const memIso = { agent: 'explore' as const, user: memoryUser(o.surface), session: runKey, task: runKey };
  const memUp = mem ? (await mem.health(1500)).ok : false;
  res.memory = { ...(memOn ? {} : { off: true }), injected: [], applied: [], service: !memOn ? 'off' : memUp ? 'ok' : 'down' };
  const lessonDelta: Record<string, { injected?: number; applied?: number }> = {};
  const finish = async (): Promise<AgentResult> => {
    endCallLogs();
    if (memOn) {
      addStats(lessonDelta);
      // L0: the run's rounds as text (screenshots by path) — the service extracts experience from them (§8.9).
      if (memUp && mem && res.steps.length) res.memory!.l0 = await mem.addConversation(memIso, l0Messages(o.goal, res.steps), 10_000);
    }
    if (outcomes.size) res.expectations = [...outcomes.values()];
    res.finishedAt = new Date().toISOString();
    res.usage = { steps: res.steps.length, seconds: Math.round((Date.now() - t0) / 1000), modelCalls: modelCalls.vision + modelCalls.text - calls0, ...(checkCalls ? { checkCalls } : {}), tokens: { input: modelCalls.tokens.input - tokens0.input, output: modelCalls.tokens.output - tokens0.output, cached: modelCalls.tokens.cached - tokens0.cached } };
    res.coverage = { screens: tried.size, actions: [...tried.values()].reduce((n, s) => n + s.size, 0), byScreen: Object.fromEntries([...tried].map(([k, v]) => [k, v.size])) };
    if (notes.size) res.notes = Object.fromEntries(notes.entries());
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
  // W3-4 §8.2′: every snapshot of the app under test goes into the page recording.
  const stopPages = bench ? undefined : startPageRecording(o.surface);
  try {
    if (!bench && onPlaywright(o.surface)) wfr = new WebFlightRecorder(flightDir);
    if (!bench && onAndroid(o.surface) && udid) afr = new AndroidFlightRecorder(udid, packageOf(o.surface) ?? TEAMILY_PACKAGE, flightDir);
    o.hooks?.phase?.('launch');
    sess = bench ? await openBenchSession(bench.udid, log) : await openSession({ surface: o.surface, env: o.env, account: accountId, udid, pool: o.pool!, headed: o.headed, onLog: afr?.onLog, onConsole: wfr?.onConsole, log });
    const s = sess;
    const android = !!bench || onAndroid(o.surface);
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

    // The page of the current step (W3-4): findings, checklist and known issues are per page.
    let page: PageMatch = { id: UNKNOWN_PAGE, name: '未知页面', lang: 'zh' };
    let prevPage: PageMatch | undefined;
    /** What the executor knows at a step, for the lessons' `when` (W3-5): the page, the previous action, its read-back. */
    const stepContext = (step: number): StepContext => {
      const prev = [...res.steps].reverse().find((x) => x.step < step);
      return { surface: o.surface, page: page.id, lastAction: prev ? actionType(prev.action) : undefined, readback: prev?.readback };
    };
    /** W3-4: every finding passes D10 and the known issues before it is kept. */
    const pushFinding = (f: Finding): Finding => {
      f.page = page.id;
      // W3-5 L2: a lesson covering this finding makes it not count (before the known issues count it).
      if (f.counted && lessons.length) {
        const l = suppressingLesson(lessons, { source: f.source, type: findingKey(f).type, text: f.source === 'detector' ? (f.text ?? f.description) : f.description, page: f.page, knownId: matchKnown(known, findingKey(f))?.id, step: f.step }, stepContext(f.step));
        if (l) {
          f.counted = false;
          f.lesson = l.id;
          f.excluded = `教训 ${l.id}：${l.preview}`;
          (lessonDelta[l.id] ??= {}).applied = (lessonDelta[l.id].applied ?? 0) + 1;
          if (!res.memory!.applied.includes(l.id)) res.memory!.applied.push(l.id);
        }
      }
      if (judging)
        updateKnown((items) => {
          judgeFinding(f, res.steps, items, runKey);
          known = items;
        }, knownFile);
      // The lesson stays the stated reason; another rule that also applies (D10) is kept after it.
      if (f.lesson) {
        const lessonWhy = `教训 ${f.lesson}：${lessons.find((l) => l.id === f.lesson)?.preview ?? ''}`;
        if (f.excluded !== lessonWhy) f.excluded = f.excluded ? `${lessonWhy}；${f.excluded}` : lessonWhy;
      }
      res.findings.push(f);
      return f;
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
      const f = pushFinding({ n: res.findings.length + 1, source: 'detector', detector: h.kind, ...(h.text ? { text: h.text } : {}), kind: 'visual-anomaly', description: h.description, step, screen, incident: dir, review: review?.verdict, counted: review?.verdict === 'consistent', path: [...path] });
      traj.emit('finding', { step, description: h.description, detector: h.kind, review: review?.verdict, counted: f.counted, known: f.known, excluded: f.excluded });
      return `detector ${h.kind}: ${h.description} (evidence review: ${review?.verdict ?? 'unverified'}${f.known && !f.known.isNew ? `; already known (${f.known.id})` : ''})`;
    };

    // W3-3 state: execution incidents, screen memory, blocks for the top of the next prompt, the final review.
    const incidents = new Incidents();
    const screens = new ScreenMemory();
    const top: string[] = [];
    let before: Rgba | undefined;
    let prevNodes: ScreenNode[] | undefined;
    let lastUnusable: string | undefined;
    let review: { key: string; changedSince: boolean } | undefined;
    let answerGiven: string | undefined;
    let lastOk: { action: string; step: number } | undefined;
    // Steps whose actions reached the device: only those are compared for "the screen did not change".
    const deviceSteps = new Set<number>();
    const marks: string[] = [];

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
      prevPage = page;
      page = pageOf(nodes);
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
      const img = (() => {
        try {
          return decodePng(png);
        } catch {
          return undefined;
        }
      })();
      // F7: did the last step's actions change the screen? (pixels; "like after step N" by dHash, no model call)
      const small = img ? downscale(img, COMPARE_WIDTH) : undefined;
      const prev = res.steps.at(-1);
      if (prev && before && small && deviceSteps.has(prev.step)) {
        const changed = screenChanged(before, small);
        const hash = dHash(small);
        const sameAs = changed ? screens.sameAs(hash, prev.step) : undefined;
        if (changed !== undefined) prev.changed = changed;
        if (sameAs) prev.sameAs = sameAs;
        screens.remember(prev.step, hash);
        if (changed === false) {
          feedback = `${feedback ?? 'ok'}; the screen did not change after this action`;
          marks.push(`step ${prev.step}: screen unchanged after ${prev.action}`);
        } else if (sameAs) feedback = `${feedback ?? 'ok'}; the screen looks like the one after step ${sameAs}`;
        if (changed && review) review.changedSince = true;
      }
      before = small;
      const newText = newScreenText(prevNodes, nodes);
      prevNodes = nodes;
      let obs: Observation | undefined;
      if (!bench) {
        obs = { at: Date.now(), img, nodes, texts: snap?.texts, width: snap?.width ?? img?.width ?? 0, height: snap?.height ?? img?.height ?? 0 };
        const hits = detect(obs, dst);
        const dead = lastTap && deadTap(lastTap.key, lastTap.obs, obs, dst, lastTap.target);
        if (dead) hits.push(dead);
        lastTap = undefined;
        const found: string[] = [];
        for (const h of hits) {
          // Once per run per page, kind and text — not per screen: a list that scrolls shows the same rows again.
          const key = `${page.id}:${h.kind}:${knownText(h.text ?? h.description)}`;
          if (seenHits.has(key)) continue;
          seenHits.add(key);
          found.push(await detectorFinding(h, step, screen));
        }
        if (found.length) feedback = `${feedback ?? 'ok'}. ${found.join('; ')}`;
      }
      const prompt = userPrompt({ goal: o.goal, mode: o.mode, plan, notes: notes.text(), history: historyText(res.steps), screen, els, tried: [...triedHere], feedback, size: vp, instructions: res.instructions?.map((x) => x.text), top: [incidents.block(), ...top.splice(0)].filter(Boolean), extra: judging ? [...expectationBlocks(expectations, page, outcomes, prevPage), knownBlock(known, page.id)].filter(Boolean) : [] });
      const system = bench ? BENCH_SYSTEM : SYSTEM(!!o.writable, ownNames);
      // W3-5 §8.7 ④: lessons for this step (deterministic, always) + related experience (best effort, 300 ms).
      let memoryText = '';
      let memoryNote: string | undefined;
      if (memOn) {
        const ctx = stepContext(step);
        const ls = lessonsForStep(lessons, ctx, 5);
        for (const l of ls) {
          (lessonDelta[l.id] ??= {}).injected = (lessonDelta[l.id].injected ?? 0) + 1;
          if (!res.memory!.injected.includes(l.id)) res.memory!.injected.push(l.id);
        }
        const hits = memUp && mem ? await mem.searchAtoms(memIso, `${page.name} ${ctx.lastAction ?? ''} ${o.goal}`.slice(0, 200), { limit: Math.max(0, Math.min(3, 5 - ls.length)), timeoutMs: 300 }) : undefined;
        if (memUp && !hits) memoryNote = '记忆服务检索超时或失败：只用仓库里的教训';
        else if (!memUp) memoryNote = '记忆服务不可用：只用仓库里的教训';
        memoryText = lessonBlock(ls, (hits ?? []).map((h) => h.content.slice(0, 200)));
      }
      // F2: an unusable answer goes back with its reason once, in the same turn.
      let got: ReturnType<typeof readAnswer> | undefined;
      let raw = '';
      for (let k = 0; k < 2 && !(got && 'answer' in got); k++) {
        const correction = got && 'error' in got ? `Your previous answer could not be used: ${got.error}\nYour previous answer was:\n${raw.slice(0, 2000)}\nAnswer again with ONE JSON object.` : '';
        const r = await modelCall({
          purpose: 'agent',
          vision: true,
          slots: [
            { name: 'role', role: 'system', stable: true, content: system },
            { name: 'step', role: 'user', content: prompt },
            { name: 'memory', role: 'user', content: memoryText, ...(memoryNote ? { note: memoryNote } : {}) },
            { name: 'screenshot', role: 'user', content: [{ label: 'Screenshot (scaled; coordinates are on the 0-1000 scale)', png: shot }] },
            { name: 'correction', role: 'user', content: correction },
          ],
          timeoutMs: MODEL_TIMEOUT_MS,
          correct: true,
        }).catch((e: Error) => ({ ok: false as const, error: e.message, raw: '' }));
        raw = r.raw ?? '';
        got = r.ok ? readAnswer(r.value, !!bench, els.length) : { error: `no usable JSON (${'error' in r ? r.error.slice(0, 160) : 'call failed'})` };
      }
      const thumb = `steps/${String(step).padStart(4, '0')}.png`;
      await writeFile(join(o.runDir, thumb), scalePng(png, THUMB_WIDTH)).catch(() => {});
      const at = Date.now() - t0;
      if (!got || 'error' in got) {
        // A service that stays busy is a tool failure, not the agent's: no conclusion from this run.
        const down = visionOutageNow();
        const why = got && 'error' in got ? got.error : 'no answer';
        traj.emit('agent.raw', { step, error: why, raw: 'model-raw.jsonl' });
        if (down) {
          res.status = 'error';
          res.summary = `模型服务不可用：${down}`;
          res.error = `vision service unavailable: ${down}`;
          break;
        }
        // F7: the turn counts as a step; the model hears about it first thing next turn. Stuck = the very same
        // unusable answer twice in a row (progress-based, no fixed count).
        const h = createHash('sha1').update(raw).digest('hex');
        res.unusable = (res.unusable ?? 0) + 1;
        if (lastUnusable === h) {
          res.status = 'failed';
          res.summary = `模型重复给出同一个不可用的回答（${why}）；原始回答见 model-raw.jsonl`;
          break;
        }
        lastUnusable = h;
        const r: StepRecord = { step, screen, action: '(none)', result: 'no usable action', thought: why.slice(0, 300), thumb, at, ...(newText ? { newText } : {}), ...(bench ? {} : { page: page.id }) };
        res.steps.push(r);
        o.onStep?.(r);
        top.push(`You did not give a usable action last turn (${why}). Please make progress with one action or done.`);
        feedback = undefined;
        continue;
      }
      lastUnusable = undefined;
      const ans: AgentAnswer = got.answer;
      plan = ans.plan ?? plan;
      res.plan = plan;
      const thought = ans.thought.slice(0, 300);
      const a = ans.action;
      const burst = [a, ...(ans.then ?? [])];
      const act = burst.map((x) => describe(x, els)).join(' → ');
      const rec: StepRecord = { step, screen, action: act, result: '', thought, thumb, at, ...(newText ? { newText } : {}), ...(bench ? {} : { page: page.id }) };
      const record = (result: string) => {
        rec.result = result;
        res.steps.push(rec);
        o.onStep?.(rec);
      };
      traj.emit('agent.step', { step, screen, thought, action: act, thumb, ...(bench ? {} : { page: page.id }) });
      // W3-4 §8.5 ①: checklist results judge the screen the model looked at (before this turn's actions).
      if (outcomes.size && ans.verify !== undefined) {
        const v = readVerify(ans.verify, new Set(outcomes.keys()));
        const said: string[] = [];
        for (const c of v.checks) {
          const out = outcomes.get(c.id)!;
          out.checks.push({ step, result: c.result, evidence: c.evidence });
          out.result = outcomeOf(out.checks);
          (rec.verified ??= []).push(`${c.id} ${c.result}`);
          traj.emit('agent.verify', { step, id: c.id, result: c.result, evidence: c.evidence });
          if (c.result !== '不符合' || out.finding !== undefined) {
            said.push(`${c.id}: ${c.result} recorded`);
            continue;
          }
          const e = expectations.find((x) => x.id === c.id)!;
          const dir = await incident('check-failed', `不符合预期 [${e.id}] ${e.trigger} → ${e.expect}；实际：${c.evidence}`, step);
          // The evidence review judges the frames against this entry, not "the app can be used normally".
          const rv = await reviewIncident(dir, { id: e.source, summary: `${e.trigger} → ${e.expect}`, expected: e.expect, actual: c.evidence }, { log, subcase: `探索预期核对 [${e.id}]` }).catch(() => undefined);
          setModelPurpose('agent');
          const f = pushFinding({ n: res.findings.length + 1, source: 'expectation', kind: 'check-failed', description: `不符合预期「${e.expect}」：${c.evidence}`, expectation: { id: e.id, trigger: e.trigger, expect: e.expect }, step, screen, incident: dir, review: rv?.verdict, counted: rv?.verdict === 'consistent', path: [...path] });
          out.finding = f.n;
          traj.emit('finding', { step, description: f.description, expectation: e.id, review: rv?.verdict, counted: f.counted, known: f.known, excluded: f.excluded });
          said.push(`${c.id}: 不符合 recorded as finding #${f.n} (evidence review: ${rv?.verdict ?? 'unverified'}${f.excluded ? `; not counted: ${f.excluded}` : ''})`);
        }
        if (v.error) said.push(`verify not used: ${v.error}`);
        if (said.length) top.push(`Checklist: ${said.join('; ')}`);
      }
      if (a.type === 'done') {
        if (a.status === 'completed' && o.mode === 'task') {
          // F6: a reported completion is reviewed before the run ends (explore runs have no end state to check).
          const ledger = res.steps.slice(-CHECK_LEDGER).map((x) => ledgerLine(x));
          const c = await runCheck({ goal: o.goal, instructions: res.instructions?.map((x) => x.text), plan, notes: notes.text(), ledger, marks, answer: answerGiven, elements: elementList(els, vp) }, shot, MODEL_TIMEOUT_MS);
          checkCalls++;
          setModelPurpose('agent');
          if ('error' in c) {
            // No usable review: the model's own verdict stands (the review must not keep a run going on its own).
            (res.checks ??= []).push({ step, passed: true, failed: [], error: c.error });
            traj.emit('agent.check', { step, error: c.error });
          } else {
            const ok = passes(c.report);
            const failed = [...c.report.verdicts.filter((v) => v.status === 'failed').map((v) => v.item), ...c.report.unmet];
            (res.checks ??= []).push({ step, passed: ok, failed });
            traj.emit('agent.check', { step, passed: ok, report: c.report });
            if (!ok) {
              const key = failureKey(c.report);
              if (review && review.key === key && !review.changedSince) {
                res.status = 'failed';
                res.summary = `复核两次结论相同、其间画面没有变化：${c.report.verdicts.filter((v) => v.status === 'failed').map((v) => `${v.item}（${v.evidence}）`).join('；') || failed.join('；')}`;
                record('done (completed) — final review not passed again, stopped');
                break;
              }
              review = { key, changedSince: false };
              top.push(feedbackBlock(c.report));
              plan = revertPlan(plan, c.report);
              res.plan = plan;
              feedback = 'your completion was reviewed and not accepted (see the final review at the top)';
              record('done (completed) → final review not passed');
              continue;
            }
          }
        }
        res.status = a.status;
        res.summary = a.summary;
        record(`done (${a.status})`);
        break;
      }
      if (a.type === 'report_issue') {
        const dir = await incident('visual-anomaly', a.description, step);
        const rv = await reviewIncident(dir, { id: 'explore', summary: o.goal, expected: '应用可以正常使用：没有报错、白屏、卡住或显示错乱', actual: a.description }, { log }).catch(() => undefined);
        const f = pushFinding({ n: res.findings.length + 1, source: 'reported', kind: 'visual-anomaly', description: a.description, step, screen, incident: dir, review: rv?.verdict, counted: rv?.verdict === 'consistent', path: [...path] });
        traj.emit('finding', { step, description: a.description, review: rv?.verdict, counted: f.counted, known: f.known, excluded: f.excluded });
        feedback = f.excluded
          ? `issue not counted: ${f.excluded.startsWith('输入没有上屏') ? 'your typed text never reached the field (the executor read it back: input not committed) — that is a test-method problem, not the app’s; try typing again or move on' : `people already marked this known issue (${f.known?.id}) as not the app’s problem — move on`}`
          : f.known && !f.known.isNew
            ? `this is a known issue (${f.known.id}, seen ${f.known.count}×) — recorded; do not spend more steps on it`
            : f.counted
              ? 'issue recorded and confirmed by the evidence review'
              : `issue recorded; the evidence review says ${rv?.verdict ?? 'unverified'} — look closer or move on`;
        record(`issue ${f.excluded ? 'not counted' : f.counted ? (f.known && !f.known.isNew ? `known (${f.known.id})` : 'confirmed') : rv?.verdict ?? 'unverified'}`);
        continue;
      }
      if (a.type === 'search_history') {
        // F8: a lookup, no device action; the answer is the next turn's action result.
        feedback = searchHistory(res.steps, notes.entries(), a);
        record(`searched history for "${a.query}"`);
        continue;
      }
      // The action, or a short burst of them on this screen (Artemis Flash click_sequence): each passes the risk
      // rules (before anything touches the app) and the pre-tap check; the burst stops at the first that does not.
      // Notes ride along and touch nothing (F5).
      const outs: string[] = [];
      let blocked: string | undefined;
      let failedAt: number | undefined;
      let deviceOk = false;
      for (const [i, b] of burst.entries()) {
        const bAct = describe(b, els);
        if (b.type === 'note') {
          let out: string;
          try {
            out = notes.apply(b);
            (rec.notes ??= []).push(b.key);
          } catch (e) {
            out = `note not written: ${(e as Error).message}`;
          }
          outs.push(out);
          continue;
        }
        const el = 'target' in b && b.target !== undefined ? els[b.target - 1] : undefined;
        const lbl = el ? label(el) : 'description' in b ? (b.description ?? '') : '';
        const yPx = el ? el.center.y : 'y' in b && b.y !== undefined ? toPx({ x: 0, y: b.y }, vp.width || 1, vp.height || 1).y : undefined;
        const own = yPx !== undefined && nearOwnContent(yPx, nodes.map((n) => ({ label: label(n), y: n.center.y })), ownNames, vp.height);
        const searchBox = b.type === 'type' && !!el && wasSearchBox(el.box, searchBoxes);
        const risk = classifyRisk({ type: b.type, label: lbl, text: b.type === 'type' ? b.text : undefined, free: !el }, !!o.writable, { ownContent: own, bench: !!bench, searchBox, toggle: !!el && /Switch|CheckBox|ToggleButton|RadioButton|CompoundButton/i.test(el.cls) });
        if (risk.blocked) {
          res.blocked.push({ step, action: bAct, reason: risk.reason });
          traj.emit('blocked', { step, action: bAct, reason: risk.reason });
          blocked = risk.reason;
          failedAt = i;
          break;
        }
        if (i) await sleep(400);
        const out = await perform(s, guard, b, el, vp, android, bench).catch((e) => `error: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
        deviceSteps.add(step);
        if (b.type === 'type') {
          (rec.typed ??= []).push(b.text);
          const rb = readbackOf(out);
          if (rb !== undefined) {
            (rec.readback ??= []).push(rb);
            marks.push(`step ${step}: typed ${JSON.stringify(b.text)} → ${rb}`);
            if (rb === 'input not committed') res.inputNotCommitted = (res.inputNotCommitted ?? 0) + 1;
          }
        }
        if (b.type === 'answer') answerGiven = b.text;
        if (obs && burst.length === 1 && el?.clickable && b.type === 'tap' && out === 'ok') lastTap = { key: actionKey(b, el), obs, target: { text: label(el), box: el.box }, at: Date.now() };
        triedHere.add(actionKey(b, el));
        path.push(bAct);
        outs.push(out);
        if (!out.startsWith('ok') && !out.startsWith('answer')) {
          failedAt = i;
          break;
        }
        lastOk = { action: bAct, step };
        deviceOk = true;
      }
      // F7: an action that did not go through opens (or continues) an execution incident; one that did closes it.
      if (failedAt !== undefined) {
        const b = burst[failedAt];
        incidents.afterTurn(step, { action: describe(b, els), reason: blocked ?? outs[failedAt] ?? 'failed', category: categoryOf(outs[failedAt] ?? '', !!blocked), index: failedAt, burst: burst.length }, lastOk);
        traj.emit('agent.incident', { step, action: describe(b, els), reason: blocked ?? outs[failedAt], category: categoryOf(outs[failedAt] ?? '', !!blocked) });
      } else if (deviceOk) incidents.afterTurn(step, undefined);
      if (blocked && !outs.length) {
        feedback = `BLOCKED: ${blocked}`;
        record(`blocked: ${blocked}`);
        continue;
      }
      feedback = burst.length === 1 ? outs[0] : `${outs.map((r, i) => `#${i + 1} ${r}`).join('; ')}${outs.length < burst.length ? ` — stopped after ${outs.length} of ${burst.length}${blocked ? ` (BLOCKED: ${blocked})` : ''}` : ''}`;
      if ('dropped' in got && got.dropped) feedback = `${feedback}; ${got.dropped}`;
      await sleep(900);
      // Bench runs judge nothing: the driver is bound to no app under test.
      const hard = bench ? [] : s.d.drainAnomalies().filter((x: Anomaly) => HARD_ANOMALIES.includes(x.kind));
      if (hard.length) {
        const x = hard[0];
        const kind = incidentKind(x.kind);
        const dir = await incident(kind, x.detail, step);
        pushFinding({ n: res.findings.length + 1, source: 'hard', kind, description: `${x.kind}: ${x.detail}`, step, screen, incident: dir, counted: true, path: [...path] });
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
    stopPages?.();
    setModelPurpose('other');
    endCallLogs();
    await afr?.stop().catch(() => {});
    await closeSession(sess);
    if (lease) o.pool!.release(lease, o.devices);
  }
  return finish();
}

/** Pure: an action as the ledger and the model see it — typed text in full (F7; it used to be cut to 40). */
export function describe(a: AgentAction, els: ScreenNode[]): string {
  const t = (n?: number) => (n !== undefined && els[n - 1] ? `#${n} "${label(els[n - 1]).slice(0, 30)}"` : '');
  switch (a.type) {
    case 'tap':
    case 'longPress':
      return `${a.type} ${a.target !== undefined ? t(a.target) : `[${a.x},${a.y}] ${a.description ?? ''}`}`.trim();
    case 'type':
      return `type ${t(a.target)} ${JSON.stringify(a.text)}${a.at && a.at !== 'end' ? ` (at ${a.at})` : ''}`.replace(/\s+/, ' ');
    case 'drag':
      return `drag [${a.x1},${a.y1}]→[${a.x2},${a.y2}]`;
    case 'swipe':
      return `swipe ${a.direction}`;
    case 'wait':
      return `wait ${a.ms}ms`;
    case 'done':
      return `done ${a.status}`;
    case 'report_issue':
      return `report_issue "${a.description.slice(0, 60)}"`;
    case 'note':
      return `note ${a.mode} '${a.key}'`;
    case 'search_history':
      return `search_history "${a.query}"`;
    case 'open_app':
      return `open_app "${a.app}"`;
    case 'answer':
      return `answer ${JSON.stringify(a.text)}`;
    default:
      return a.type;
  }
}

const actionKey = (a: AgentAction, el?: ScreenNode) => `${a.type}${el ? `:${label(el).slice(0, 20)}` : 'direction' in a ? `:${a.direction}` : ''}`;

/** Pure: the read-back part of a type result (F9): the field's text, `field not readable` or `input not committed`. */
export function readbackOf(out: string): string | undefined {
  if (/^input not committed/.test(out)) return 'input not committed';
  if (/field not readable/.test(out)) return 'field not readable';
  const m = out.match(/field now: "([\s\S]*)"/);
  return m ? m[1] : undefined;
}

const normText = (s: string) => s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();

/** Pure: does the field's text show what was typed (F9)? replace → equal; end / start → contained. */
export function landed(value: string, typed: string, at: TypeAt): boolean {
  const v = normText(value);
  const t = normText(typed.replace(/\\n/g, '\n'));
  if (!t) return true;
  return at === 'replace' ? v === t : v.includes(t);
}

/** Pure: the input the text went into — the focused input, else the input over the target element. */
export function fieldAfterTyping(nodes: ScreenNode[], target?: ScreenNode): ScreenNode | undefined {
  const inputs = nodes.filter((n) => /EditText|textbox|textarea|searchbox|combobox/i.test(n.cls));
  const focused = inputs.find((n) => n.focused);
  if (focused) return focused;
  if (!target) return inputs.length === 1 ? inputs[0] : undefined;
  return inputs
    .map((n) => ({ n, d: Math.hypot(n.center.x - target.center.x, n.center.y - target.center.y) }))
    .filter((x) => x.d < Math.max(40, target.box[3]))
    .sort((p, q) => p.d - q.d)[0]?.n;
}

/** Run one action through the recording driver; the pre-tap check guards taps on listed elements. */
async function perform(s: Session, guard: PreTapGuard, a: AgentAction, el: ScreenNode | undefined, vp: { width: number; height: number }, android: boolean, bench?: BenchLink): Promise<string> {
  let moved = '';
  const d = s.d;
  d.label = a.type;
  const px = (x: number, y: number): Point => toPx({ x, y }, vp.width, vp.height);
  const pointOf = async (purpose: string): Promise<Point | string> => {
    if (el) {
      const r = await guard.check(el.center, { purpose, text: label(el) || undefined, rid: el.rid || undefined, box: el.box });
      // The same element, clearly identified, only further away (a list that scrolled on): tap it where it is now.
      if (r.kind === 'shifted' && r.how === 'tree' && r.to && (r.score ?? 0) >= SHIFT_RETARGET_SCORE) {
        moved = ` (the target had moved to (${r.to.x},${r.to.y}); tapped it there)`;
        return r.to;
      }
      if (r.kind !== 'pass' && r.kind !== 'corrected' && r.kind !== 'uncertain') return `pre-tap check: target ${r.kind} (${r.detail}) — not tapped`;
      return r.point;
    }
    // F3: coordinates come on the 0–1000 scale; the code converts them.
    if ('x' in a && a.x !== undefined && 'y' in a && a.y !== undefined) return px(a.x, a.y);
    return 'no target';
  };
  switch (a.type) {
    case 'tap':
    case 'longPress': {
      const p = await pointOf(a.type);
      if (typeof p === 'string') return p;
      if (a.type === 'tap') await d.tap(p);
      else await d.longPress(p);
      return moved ? `ok${moved}` : 'ok';
    }
    case 'type':
      return typeInto(s, a, el, android, !!bench, pointOf);
    case 'drag': {
      await d.swipe(px(a.x1, a.y1), px(a.x2, a.y2), 600);
      return 'ok';
    }
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

/** F9: type into a field — focus it only when it is not focused yet (a tap moves the cursor to where it lands),
 *  put the cursor where `at` says, type line by line in the device's input mode, then read the field back. Text
 *  that did not land is typed once more the other way (yadb ↔ key events); still missing → `input not committed`
 *  (a test-method problem, not the app's: W3-4 does not count what follows it). Ported from
 *  ref/artemis/artemis/mcp/actuators/adb.py L45-98 (ensure_focus_at_coords), L189-232 (input_text) and
 *  third_party/mobile_use/controllers/unified_controller.py L141-157 (erase_text) (Apache-2.0); the read-back is ours. */
async function typeInto(s: Session, a: Extract<AgentAction, { type: 'type' }>, el: ScreenNode | undefined, android: boolean, bench: boolean, pointOf: (purpose: string) => Promise<Point | string>): Promise<string> {
  const d = s.d;
  const at: TypeAt = a.at ?? 'end';
  if (el && !el.focused) {
    const p = await pointOf('focus input');
    if (typeof p === 'string') return p;
    await d.tap(p);
    await sleep(1000);
  }
  const place = async () => {
    if (!android) {
      // Web: select-all + delete replaces; the cursor keys differ per field, so start / end are left as they are.
      if (at === 'replace') {
        await d.key('selectall');
        await d.key('del');
      }
      return;
    }
    // Ctrl+MOVE_HOME / Ctrl+MOVE_END: the start / end of the whole text (MOVE_END alone, as in Artemis, stops at
    // the end of the current line of a multi-line field).
    if (at === 'start') await d.key('ctrlhome');
    else {
      await d.key('ctrlend');
      if (at === 'replace') {
        await d.key('selectall');
        for (let i = 0; i < 21; i++) await d.key('del');
      }
    }
  };
  await place();
  // Web: a literal "\n" from the model is a new line too (the Android driver handles it per line).
  await d.typeText(android ? a.text : a.text.replace(/\\n/g, '\n'));
  if (!android) return 'ok';
  const read = async (): Promise<string | undefined> => {
    await sleep(400);
    const snap = await snapshot(s.inner, { skipStable: true, ...(bench ? { pkg: '' } : {}) }).catch(() => undefined);
    const f = snap ? fieldAfterTyping(snap.nodes, el) : undefined;
    if (!f || /password/i.test(`${f.rid} ${f.cls}`) || /^[•●*]+$/.test(f.text)) return undefined;
    return f.text;
  };
  let value = await read();
  if (value === undefined) return 'ok; field not readable';
  if (landed(value, a.text, at)) return `ok; field now: "${value}"`;
  // Not in the field: once more the other way (the IME may have held key events in its composition bar).
  const other = (d.inputMode ?? 'direct') === 'direct' ? 'keys' : 'direct';
  if (at === 'replace') await place();
  await d.typeText(a.text, other);
  value = await read();
  if (value !== undefined && landed(value, a.text, at)) return `ok (typed again via ${other === 'direct' ? 'direct input' : 'key events'}); field now: "${value}"`;
  return `input not committed; field now: "${value ?? ''}"`;
}


export function agentMarkdown(r: AgentResult): string {
  const counted = r.findings.filter((f) => f.counted);
  const st: Record<AgentResult['status'], string> = { completed: '完成', failed: '未能完成', limit: '到达上限', cancelled: '已取消', 'env-unfit': '环境不合格', error: '执行出错' };
  const ps = planState(r.plan);
  const checks = r.checks ?? [];
  return [
    `# ${r.mode === 'explore' ? '探索' : '自然语言任务'}：${r.goal}`,
    '',
    `- 结果：**${st[r.status]}** — ${r.summary || '-'}`,
    `- 发现：${counted.length ? `${counted.length} 个（见下）` : `没有发现问题（覆盖 ${r.coverage.screens} 个界面、${r.coverage.actions} 个动作，拦截 ${r.blocked.length} 次）`}`,
    `- 执行端：${r.surface}（${r.env}）；账号 ${r.account ?? '-'}；${r.writable ? '可写' : '只读'}`,
    `- 用量：${r.usage.steps} 步，${r.usage.seconds} 秒，模型调用 ${r.usage.modelCalls} 次${r.usage.checkCalls ? `（其中结束复核 ${r.usage.checkCalls} 次）` : ''}`,
    checks.length ? `- 结束复核：${checks.length} 次，通过 ${checks.filter((c) => c.passed && !c.error).length}，不通过 ${checks.filter((c) => !c.passed).length}${checks.some((c) => c.error) ? `，复核不可用 ${checks.filter((c) => c.error).length}` : ''}` : '',
    r.unusable ? `- 模型没给出可用动作：${r.unusable} 轮` : '',
    r.inputNotCommitted ? `- 输入没上屏：${r.inputNotCommitted} 次` : '',
    r.plan ? `- 计划：完成 ${ps.done}，未完成 ${ps.todo}，失败 ${ps.failed}` : '',
    '',
    ...(r.findings.length ? ['## 发现', '', ...r.findings.map((f) => `- #${f.n} ${f.counted ? '✅' : '⚠'} ${findingState(f)} · ${FINDING_SOURCE[f.source]}（${f.detector ?? f.kind}${f.page ? `，${f.page}` : ''}）：${f.description}${f.review ? `；证据复核：${f.review}` : ''} — 第 ${f.step} 步，现场包 \`${f.incident}\``), ''] : []),
    ...(r.expectations?.length ? ['## 预期核对', '', ...r.expectations.map((e) => `- [${e.id}] ${e.result}${e.checks.length ? `（第 ${e.checks.map((c) => c.step).join('、')} 步）` : ''}：${e.trigger} → ${e.expect}${e.checks.at(-1)?.evidence ? `；证据：${e.checks.at(-1)!.evidence}` : ''}${e.finding ? `；发现 #${e.finding}` : ''}`), ''] : []),
    ...(r.blocked.length ? ['## 拦截的动作', '', ...r.blocked.map((b) => `- 第 ${b.step} 步 ${b.action}：${b.reason}`), ''] : []),
    ...(r.plan ? ['## 计划（模型维护）', '', r.plan, ''] : []),
    ...(r.notes && Object.keys(r.notes).length ? ['## 笔记（模型记录）', '', ...Object.entries(r.notes).map(([k, v]) => `### ${k}\n\n${v}`), ''] : []),
    '## 步骤',
    '',
    ...r.steps.map((x) => `- ${ledgerLine(x)}`),
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Pure: a run's rounds as L0 messages (W3-5 §8.9): the goal, then per step the model's thought and action
 *  (assistant) and what came of it (user). Text only — a screenshot is named by its path. */
export function l0Messages(goal: string, steps: StepRecord[]): MemoryMessage[] {
  const out: MemoryMessage[] = [{ role: 'user', content: `探索目标：${goal}` }];
  for (const st of steps) {
    out.push({ role: 'assistant', content: `#${st.step} [${st.page ?? '-'}] ${st.thought ? `${st.thought.slice(0, 400)} → ` : ''}${st.action}` });
    out.push({ role: 'user', content: `${st.result}${st.readback?.length ? ` | 读回：${st.readback.join(' / ')}` : ''}${st.thumb ? ` | 截图 ${st.thumb}` : ''}` });
  }
  return out;
}
