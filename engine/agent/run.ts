// Quick tier (capability ①): one agent loop on a real phone / browser — after ref/artemis Flash (Apache-2.0,
// rewritten). Each step: screen snapshot (screenshot + numbered elements) → the vision model picks one action →
// risk rules (read-only by default) → pre-tap check → the action through the recording driver → the driver's
// event stream. Hard anomalies are findings at once; a problem the model reports is written as an incident and
// counts only after the evidence review. Same session, recorders, incident bundles and replay files as the pro
// tier (engine/plan). Ends when the agent reports done, at the step / time limits, or on cancel.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelCalls, setModelPurpose, visionConfigured, visionJson } from '../../core/model/llm';
import { label, type ScreenNode } from '../../core/screen-index';
import { isoMs, openTrajectory } from '../../core/trajectory';
import { TEAMILY_PACKAGE } from '../../drivers/factory';
import { type Anomaly, HARD_ANOMALIES, type Point, sleep } from '../../drivers/types';
import type { AccountPool, Lease } from '../../platform/accounts/account-pool';
import { type Env, onAndroid, onPlaywright, type Surface } from '../../platform/accounts/types';
import type { DevicePool } from '../../platform/device-pool';
import { CancelledError, type RunHooks } from '../../platform/lifecycle/runtime';
import type { TestPlan } from '../../platform/schema/test-plan';
import { HARD_LIMITS } from '../../platform/schema/test-plan';
import { leaseFor, preflightFor } from '../lease';
import { PreTapGuard } from '../pretap';
import { AndroidFlightRecorder } from '../recorder/android-recorder';
import { incidentDir, incidentKind, type IncidentKind, type ReplayFile, writeIncident } from '../recorder/bundle';
import { type EvidenceVerdict, reviewIncident } from '../recorder/evidence-review';
import { WebFlightRecorder } from '../recorder/web-recorder';
import { closeSession, enterApp, openBenchSession, openSession, packageOf, type Session } from '../session';
import { snapshot } from '../snapshot';
import { classifyRisk, nearOwnContent } from './risk';
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
  /** Defaults: no own cap (Artemis Flash) — the platform hard limits apply (D9). */
  maxSteps?: number;
  maxMinutes?: number;
  runDir: string;
  taskId?: string;
  hooks?: Partial<RunHooks>;
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
  /** hard = crash / ANR / app-exit / page-crash; reported = the agent's report_issue, after evidence review. */
  source: 'hard' | 'reported';
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
  runDir: string;
  error?: string;
}

const MODEL_TIMEOUT_MS = 180_000;
/** Screenshot width sent to the model (tokens); taps stay in the element coordinate space. */
const SHOT_WIDTH = 720;
/** Step thumbnails for the task page. */
const THUMB_WIDTH = 240;

/** The minimal plan an incident bundle carries for a quick-tier run (no Issue behind it). */
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
    limits: { maxSteps: HARD_LIMITS.maxSteps, maxMinutes: HARD_LIMITS.maxMinutes, maxIntervalMs: 1000 },
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
  const maxSteps = Math.min(o.maxSteps ?? HARD_LIMITS.maxSteps, HARD_LIMITS.maxSteps);
  const deadline = t0 + Math.min(o.maxMinutes ?? HARD_LIMITS.maxMinutes, HARD_LIMITS.maxMinutes) * 60_000;
  const tried = new Map<string, Set<string>>();
  const ownNames = o.pool?.ownContent(o.env) ?? [];
  const finish = async (): Promise<AgentResult> => {
    res.finishedAt = new Date().toISOString();
    res.usage = { steps: res.steps.length, seconds: Math.round((Date.now() - t0) / 1000), modelCalls: modelCalls.vision + modelCalls.text - calls0 };
    res.coverage = { screens: tried.size, actions: [...tried.values()].reduce((n, s) => n + s.size, 0), byScreen: Object.fromEntries([...tried].map(([k, v]) => [k, v.size])) };
    await writeFile(join(o.runDir, 'result.json'), JSON.stringify(res, null, 2));
    await writeFile(join(o.runDir, 'report.md'), agentMarkdown(res));
    traj.emit('verdict', { conclusion: res.status, detail: res.summary, findings: res.findings.filter((f) => f.counted).length });
    await traj.close({ runId: id, query: o.goal, startedAt: isoMs(t0), endedAt: isoMs(Date.now()), model: process.env.MIDSCENE_MODEL_NAME ?? '', account: res.account ?? '', output: { status: res.status, findings: res.findings.length, coverage: res.coverage } }).catch(() => {});
    return res;
  };
  if (!visionConfigured()) {
    res.error = 'vision model not configured (MIDSCENE_MODEL_*)';
    res.summary = '没有视觉模型配置，快速档无法运行';
    return finish();
  }

  // ---- lease + preflight (shared with the pro tier); bench runs use their emulator as it is
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
      await writeIncident({ runDir: o.runDir, n, kind, at, detail, plan: planStub(o, id), step, round: 1, action: s.d.label, env: { account: accountId, device: udid, ...(cap && 'state' in cap ? cap.state : {}) }, ops: s.d.ops, frames: [], replay, videos: cap && 'videos' in cap ? cap.videos : undefined, traces: cap && 'traces' in cap ? cap.traces : undefined, logFrom: cap?.logFrom ?? at - 180_000, logTo: cap?.logTo ?? at, clockOffsetMs: afr?.clockOffsetMs, dir });
      return dir;
    };

    for (let step = 1; ; step++) {
      if (o.hooks?.shouldStop?.()) throw new CancelledError();
      if (step > maxSteps || Date.now() > deadline) {
        res.status = 'limit';
        res.summary = step > maxSteps ? `到达步数上限 ${maxSteps}` : `到达时长上限 ${Math.round((deadline - t0) / 60_000)} 分钟`;
        break;
      }
      s.d.step = step;
      s.d.round = 1;
      // Bench: whatever app is in front (the driver is bound to the launcher); otherwise the app under test.
      const snap = await snapshot(s.inner, { keepPng: true, stableMaxMs: 1500, ...(bench ? { pkg: '' } : {}) }).catch(() => undefined);
      const nodes: ScreenNode[] = snap?.nodes ?? [];
      const els = visibleElements(nodes);
      const screen = fingerprint(nodes);
      const triedHere = tried.get(screen) ?? new Set<string>();
      tried.set(screen, triedHere);
      const png = snap?.png ?? (await s.inner.screenshot());
      const shot = scalePng(png, SHOT_WIDTH);
      const vp = s.profile.viewport.width ? s.profile.viewport : { width: snap?.width ?? 0, height: snap?.height ?? 0 };
      const prompt = userPrompt({ goal: o.goal, mode: o.mode, plan, history: historyText(res.steps), screen, els, tried: [...triedHere], feedback, size: vp });
      let ans: AgentAnswer | undefined;
      const system = bench ? BENCH_SYSTEM : SYSTEM(!!o.writable, ownNames);
      for (let k = 0; k < 2 && !ans; k++) ans = parseAnswer(await visionJson(system, [prompt, { label: 'Screenshot (scaled; use the element coordinates for taps)', png: shot }], MODEL_TIMEOUT_MS).catch(() => undefined), !!bench);
      if (!ans) {
        res.status = 'failed';
        res.summary = '模型连续两次没有给出可用的动作';
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
      const act = describe(a, els);
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
      // Risk rules before anything touches the app.
      const el = 'target' in a && a.target !== undefined ? els[a.target - 1] : undefined;
      const lbl = el ? label(el) : 'description' in a ? (a.description ?? '') : '';
      const y = el ? el.center.y : 'y' in a ? a.y : undefined;
      const own = y !== undefined && nearOwnContent(y, nodes.map((n) => ({ label: label(n), y: n.center.y })), ownNames, vp.height);
      const risk = classifyRisk({ type: a.type, label: lbl, text: a.type === 'type' ? a.text : undefined, free: !el }, !!o.writable, { ownContent: own, bench: !!bench });
      if (risk.blocked) {
        res.blocked.push({ step, action: act, reason: risk.reason });
        traj.emit('blocked', { step, action: act, reason: risk.reason });
        feedback = `BLOCKED: ${risk.reason}`;
        record(`blocked: ${risk.reason}`);
        continue;
      }
      feedback = await perform(s, guard, a, el, vp, bench).catch((e) => `error: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
      triedHere.add(actionKey(a, el));
      path.push(act);
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
      return `type ${t(a.target)} "${a.text.slice(0, 40)}"`;
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
      await d.type(a.text);
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
    ...(r.findings.length ? ['## 发现', '', ...r.findings.map((f) => `- #${f.n} ${f.counted ? '✅' : '⚠ 未计入'} ${f.source === 'hard' ? '硬异常' : '模型报告'}（${f.kind}）：${f.description}${f.review ? `；证据复核：${f.review}` : ''} — 第 ${f.step} 步，现场包 \`${f.incident}\``), ''] : []),
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
