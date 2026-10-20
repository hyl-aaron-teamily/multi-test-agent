// Executes a MissionPlan on one device, bounded by steps AND wall-clock time.
//
//   round = cold/warm (re)launch → entryInstruction → scenario actions → N exploratory actions → checks
//   repeat rounds until: a finding (stopOnFirstFinding) | maxSteps | deadline | external abort.
//
// Findings: crash / anr (logcat, source of truth), app-exit (left foreground without a crash log),
// check-failed (plan check answered false twice), visual (AI sees error/blank/spinner, confirmed twice),
// jank (dumpsys gfxinfo janky-frame ratio over threshold), action-failed (same action fails repeatedly).
// Reuses core/ (adb, logcat monitor) and explore/ observer + scoring; explore/ itself is not modified.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AndroidAgent } from '@midscene/android';
import { adb, launchApp, screencap } from '../core/adb';
import type { CrashEvent, LogcatMonitor } from '../core/logcat-monitor';
import { scoreElement } from '../explore/explore-loop';
import { elementKey, observeInteractiveElements } from '../explore/page-observer';
import { currentActivity } from '../explore/state-tracker';
import { executeOp, type ReplayOp, sliceFromLastLaunch, writeBundle } from '../replay/ops';
import type { ScreenRecorder } from '../replay/screen-recorder';
import type { MissionPlan } from './planner';

export type FindingKind = 'crash' | 'anr' | 'app-exit' | 'check-failed' | 'visual' | 'jank' | 'action-failed';

export interface Finding {
  kind: FindingKind;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  round: number;
  step: number;
  at: string;
  screenshot?: string;
  crashDir?: string;
  /** Last actions before the finding — the reproduction path. */
  trail: string[];
  /** Instant-replay bundle (ops since last launch + pre-event video). */
  replayDir?: string;
}

export interface MissionStep {
  step: number;
  round: number;
  at: string;
  phase: 'launch' | 'entry' | 'scenario' | 'explore' | 'check' | 'system';
  action: string;
  ok: boolean;
  ms: number;
  error?: string;
  /** Replayable form of the action (absent for checks). */
  op?: ReplayOp;
}

export interface RoundStat {
  round: number;
  startedAt: string;
  steps: number;
  jank?: JankStats;
}

export interface JankStats {
  totalFrames: number;
  jankyFrames: number;
  jankyPercent: number;
  p90Ms?: number;
  p99Ms?: number;
}

export interface MissionResult {
  steps: MissionStep[];
  rounds: RoundStat[];
  findings: Finding[];
  stopReason: 'finding' | 'max-steps' | 'max-minutes' | 'aborted' | 'error';
  stopDetail?: string;
  crashes: CrashEvent[];
}

export interface RunOptions {
  packageName: string;
  udid?: string;
  outDir: string;
  /** Absolute epoch ms; no new action starts after it. */
  deadline: number;
  shouldAbort?: () => boolean;
  /** Janky-frame % that counts as a fluency problem (with >= 60 frames). */
  jankThreshold?: number;
  /** Labels never touched even in fully-open mode: real payment confirmation and account logout. */
  hardBlock?: RegExp;
  /** Filled in place while running, so a watchdog can report partial results. */
  live?: MissionResult;
  /** Ring screen recorder; its newest segments go into each finding's replay bundle. */
  recorder?: ScreenRecorder;
  missionId?: string;
}

export const HARD_BLOCK = /确认支付|立即支付|确认付款|立即购买|pay now|confirm payment|place order|退出登录|注销账号|删除账号|log ?out|sign ?out|delete account/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BACKGROUND = /后台|background|切回前台|home key|桌面/i;

/** Parse `dumpsys gfxinfo <pkg>` summary. Pure, exported for tests. */
export function parseGfxinfo(out: string): JankStats | undefined {
  const total = out.match(/Total frames rendered:\s*(\d+)/);
  const janky = out.match(/Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/);
  if (!total || !janky) return undefined;
  const p = (n: number) => Number(out.match(new RegExp(`${n}th percentile:\\s*(\\d+)ms`))?.[1] ?? NaN);
  return {
    totalFrames: Number(total[1]),
    jankyFrames: Number(janky[1]),
    jankyPercent: Number(janky[2]),
    ...(Number.isFinite(p(90)) ? { p90Ms: p(90) } : {}),
    ...(Number.isFinite(p(99)) ? { p99Ms: p(99) } : {}),
  };
}

export async function runMission(agent: AndroidAgent, monitor: LogcatMonitor, plan: MissionPlan, o: RunOptions): Promise<MissionResult> {
  const { packageName: pkg, udid } = o;
  const hardBlock = o.hardBlock ?? HARD_BLOCK;
  const jankThreshold = o.jankThreshold ?? Number(process.env.MISSION_JANK_THRESHOLD ?? 40);
  const live = o.live ?? { steps: [], rounds: [], findings: [], stopReason: 'aborted', crashes: [] };
  const { steps, rounds, findings } = live;
  const failCount = new Map<string, number>();
  let round = 0;
  let stopReason: MissionResult['stopReason'] | undefined;
  let stopDetail: string | undefined;
  await mkdir(o.outDir, { recursive: true });

  const trail = () => steps.slice(-8).map((s) => `#${s.step} [${s.phase}] ${s.action}${s.ok ? '' : ' ✗'}`);
  const budgetLeft = (): boolean => {
    // Deadline first: the watchdog's abort at the deadline is a time limit, not a cancel.
    if (Date.now() >= o.deadline) return (stopReason = 'max-minutes'), false;
    if (o.shouldAbort?.()) return (stopReason = 'aborted'), false;
    if (steps.length >= plan.maxSteps) return (stopReason = 'max-steps'), false;
    return true;
  };
  const shoot = async (name: string) => {
    const file = join(o.outDir, `${name}.png`);
    const png = await screencap(udid).catch(() => undefined);
    if (!png) return undefined;
    await writeFile(file, png);
    return file;
  };
  const addFinding = async (f: Omit<Finding, 'round' | 'step' | 'at' | 'trail' | 'screenshot'> & { screenshot?: string }) => {
    const n = findings.length + 1;
    const finding: Finding = {
      ...f,
      round,
      step: steps.length,
      at: new Date().toISOString(),
      trail: trail(),
      screenshot: f.screenshot ?? (await shoot(`finding-${n}`)),
    };
    findings.push(finding);
    console.log(`[mission] ⚠ finding #${n} [${f.severity}] ${f.kind}: ${f.title}`);
    // Instant replay: what was done since the last launch + the video of the last minute or so.
    try {
      const dir = join(o.outDir, `replay-${n}`);
      const videos = o.recorder ? await o.recorder.snapshot(dir) : [];
      await writeBundle(dir, {
        version: 1,
        source: 'mission',
        missionId: o.missionId ?? '',
        packageName: pkg,
        udid: udid ?? null,
        createdAt: finding.at,
        finding: { kind: f.kind, title: f.title, detail: f.detail, crashDir: f.crashDir },
        ops: sliceFromLastLaunch(steps),
        videos,
        recorder: o.recorder?.describe() ?? null,
        replayCommand: `pnpm autotest replay ${join(dir, 'replay.json').replace(/\\/g, '/')} --times 3`,
      });
      finding.replayDir = dir;
      console.log(`[mission] replay bundle → ${dir}${videos.length ? ` (${videos.length} video segment(s))` : ''}`);
    } catch (err) {
      console.warn(`[mission] replay bundle failed: ${(err as Error).message}`);
    }
    if (plan.stopOnFirstFinding) {
      stopReason = 'finding';
    }
  };
  const stopped = () => stopReason === 'finding' || stopReason === 'aborted';
  const relaunchAfterDeath = async () => {
    await launchApp(pkg, udid).catch(() => {});
    await sleep(5_000);
  };

  /** One bounded action; afterwards check crash / exit. Returns false when the mission must stop. */
  const act = async (phase: MissionStep['phase'], action: string, what: ReplayOp | (() => Promise<unknown>)): Promise<boolean> => {
    const op = typeof what === 'function' ? undefined : what;
    const fn = op ? () => executeOp(agent, op, pkg, udid) : (what as () => Promise<unknown>);
    if (!budgetLeft()) return false;
    const crashesBefore = monitor.crashes.length;
    const t0 = Date.now();
    monitor.setContext({ iteration: round, step: `${phase}: ${action}` });
    const rec: MissionStep = { step: steps.length + 1, round, at: new Date().toISOString(), phase, action, ok: true, ms: 0, ...(op ? { op } : {}) };
    try {
      await fn();
    } catch (err) {
      rec.ok = false;
      rec.error = (err as Error).message.split('\n')[0].slice(0, 300);
    }
    rec.ms = Date.now() - t0;
    steps.push(rec);
    console.log(`[mission] r${round} #${rec.step} [${phase}] ${action.slice(0, 90)} ${rec.ok ? '✓' : `✗ ${rec.error}`} (${rec.ms}ms)`);

    await sleep(1_500);
    for (let i = 0; i < 4 && monitor.crashes.length === crashesBefore; i++) await sleep(500);
    const newCrashes = monitor.crashes.slice(crashesBefore).filter((c) => c.matchesPackage);
    if (newCrashes.length) {
      const c = newCrashes[0];
      const anr = c.keywords.includes('ANR in') && !c.keywords.includes('FATAL EXCEPTION');
      await addFinding({
        kind: anr ? 'anr' : 'crash',
        severity: 'high',
        title: anr ? `ANR：${action}` : `闪退：${action}`,
        detail: c.firstLine,
        crashDir: c.dir,
        screenshot: join(c.dir, 'screenshot.png'),
      });
      // Bring the app back so a --keep-going run continues instead of re-reporting the dead process.
      if (!stopped()) await relaunchAfterDeath();
      return !stopped();
    }
    if (phase !== 'launch' && !(await currentActivity(udid)).startsWith(`${pkg}/`)) {
      // Left the app without a crash log: could be a silent native crash or an external intent.
      const alive = (await adb(['shell', 'pidof', pkg], udid).catch(() => '')).trim();
      if (!alive) {
        await addFinding({ kind: 'app-exit', severity: 'high', title: `进程消失（无 Java 崩溃日志）：${action}`, detail: 'App 进程在动作后不存在，logcat 未出现 FATAL EXCEPTION，疑似 native 崩溃或被系统杀死' });
        if (!stopped()) await relaunchAfterDeath();
        return !stopped();
      }
      await adb(['shell', 'input', 'keyevent', '4'], udid).catch(() => {});
      await sleep(1_000);
      if (!(await currentActivity(udid)).startsWith(`${pkg}/`)) await launchApp(pkg, udid).catch(() => {});
    }
    if (!rec.ok) {
      const k = `${phase}:${action}`;
      failCount.set(k, (failCount.get(k) ?? 0) + 1);
      if (failCount.get(k) === 3) {
        await addFinding({ kind: 'action-failed', severity: 'medium', title: `动作连续 3 次无法完成：${action}`, detail: rec.error ?? '' });
        return !stopped();
      }
    }
    return true;
  };

  /** Ask twice (a few seconds apart) to filter out transient states / model noise. */
  const confirmFalse = async (statement: string): Promise<boolean> => {
    for (let i = 0; i < 2; i++) {
      const ok = await agent.aiBoolean(`Is this statement true for the current screen? "${statement}"`).catch(() => true);
      if (ok) return false;
      if (i === 0) await sleep(3_000);
    }
    return true;
  };

  const runChecks = async (): Promise<void> => {
    for (const check of plan.checks) {
      if (stopped() || !budgetLeft()) return;
      let failed = false;
      await act('check', `check: ${check}`, async () => {
        failed = await confirmFalse(check);
      });
      if (failed) {
        // Statements about motion/timing cannot be judged from a still frame: drop instead of reporting.
        const judgeable = await agent
          .aiBoolean(`Can this statement be judged true or false from a single still screenshot (it describes a visible state, not motion or timing)? "${check}"`)
          .catch(() => true);
        if (!judgeable) {
          console.log(`[mission] check skipped (not judgeable from a screenshot): ${check}`);
          continue;
        }
        await addFinding({ kind: 'check-failed', severity: 'medium', title: `检查未通过：${check}`, detail: '同一检查间隔 3 秒问两次均为否' });
        if (stopped()) return;
      }
    }
    if (stopped() || !budgetLeft()) return;
    let problem: { hasProblem?: boolean; kind?: string; description?: string } | undefined;
    await act('check', 'visual sanity probe', async () => {
      problem = await agent.aiQuery<{ hasProblem: boolean; kind: string; description: string }>(
        '{hasProblem: boolean, kind: string, description: string}, does the screen show a visible defect: an error/toast saying something failed, ' +
          'a blank/white area where content should be, an endless loading spinner, overlapping text, a broken image, an empty list that should have items, ' +
          'or raw/unrendered placeholder text shown to the user instead of real content (e.g. "[自定义消息]", "[custom message]", "{{name}}", "null", "undefined", "[object Object]")? ' +
          'Ellipsis truncation of long names and content hidden under a floating bar while scrolled are normal. ' +
          'kind = short category, description = what exactly (Chinese). Normal empty states with explanatory text are NOT defects.',
      );
    });
    if (problem?.hasProblem && problem.description) {
      await sleep(3_000);
      const still = await agent.aiBoolean(`Is this still visible on screen: ${problem.description}`).catch(() => false);
      if (still) await addFinding({ kind: 'visual', severity: 'medium', title: `界面异常：${problem.description}`, detail: `类别：${problem.kind ?? '-'}（两次观察一致）` });
    }
  };


  try {
    while (!stopped() && budgetLeft()) {
      round++;
      const roundStart = steps.length;
      const stat: RoundStat = { round, startedAt: new Date().toISOString(), steps: 0 };
      rounds.push(stat);
      console.log(`\n[mission] ===== round ${round} =====`);

      // Alternate cold and warm starts: intermittent bugs often depend on process state.
      const cold = round % 2 === 1;
      if (!(await act('launch', cold ? 'cold start (force-stop + launch)' : 'warm start (launch)', { kind: 'launch', cold }))) break;
      if (plan.measureJank) await adb(['shell', 'dumpsys', 'gfxinfo', pkg, 'reset'], udid).catch(() => {});

      if (plan.entryInstruction && !(await act('entry', plan.entryInstruction, { kind: 'aiAct', prompt: plan.entryInstruction }))) break;

      for (const s of plan.scenario) {
        if (hardBlock.test(s)) continue;
        const ok = BACKGROUND.test(s) ? await act('system', s, { kind: 'background', ms: 3_000 }) : await act('scenario', s, { kind: 'aiAct', prompt: s });
        if (!ok) break;
      }
      if (stopped() || !budgetLeft()) break;

      // Exploration inside the area: untried, focus-first, everything allowed except hardBlock.
      const tried = new Set<string>();
      for (let i = 0; i < plan.exploreStepsPerRound && !stopped() && budgetLeft(); i++) {
        const els = (await observeInteractiveElements(agent, `the tester is checking: ${plan.targetArea}`).catch(() => []))
          .filter((e) => !hardBlock.test(`${e.label} ${e.description}`) && !tried.has(elementKey(e)));
        if (!els.length) {
          await act('explore', 'back (nothing new here)', { kind: 'key', code: 4 });
          continue;
        }
        // Mostly the best-scoring element, sometimes a random one, to vary the path between rounds.
        els.sort((a, b) => scoreElement(b, plan.focusTerms.map((t) => t.toLowerCase())) - scoreElement(a, plan.focusTerms.map((t) => t.toLowerCase())));
        const el = Math.random() < 0.7 ? els[0] : els[Math.floor(Math.random() * els.length)];
        tried.add(elementKey(el));
        const locate = `the ${el.type} "${el.label}"`;
        if (el.type === 'input') await act('explore', `type into ${locate}`, { kind: 'aiInput', locate, value: `autotest ${new Date().toLocaleTimeString()}` });
        else await act('explore', `tap ${locate}`, { kind: 'aiTap', locate });
      }
      if (stopped() || !budgetLeft()) break;

      if (plan.entryInstruction) await act('entry', `return to ${plan.targetArea}`, { kind: 'aiAct', prompt: `make sure the ${plan.targetArea} screen is shown; navigate back to it if not` });
      await runChecks();

      if (plan.measureJank) {
        const jank = parseGfxinfo(await adb(['shell', 'dumpsys', 'gfxinfo', pkg], udid).catch(() => ''));
        stat.jank = jank;
        if (jank) console.log(`[mission] jank r${round}: ${jank.jankyFrames}/${jank.totalFrames} (${jank.jankyPercent}%) p90=${jank.p90Ms}ms p99=${jank.p99Ms}ms`);
        if (jank && jank.totalFrames >= 60 && jank.jankyPercent >= jankThreshold && !stopped()) {
          await addFinding({
            kind: 'jank',
            severity: jank.jankyPercent >= 60 ? 'medium' : 'low',
            title: `卡顿：本轮 ${jank.jankyPercent}% 帧超时（阈值 ${jankThreshold}%）`,
            detail: `dumpsys gfxinfo：${jank.jankyFrames}/${jank.totalFrames} janky，p90 ${jank.p90Ms ?? '?'}ms，p99 ${jank.p99Ms ?? '?'}ms`,
          });
        }
      }
      stat.steps = steps.length - roundStart;
    }
  } catch (err) {
    stopReason = 'error';
    stopDetail = (err as Error).message;
  }
  for (const r of rounds) if (!r.steps) r.steps = steps.filter((s) => s.round === r.round).length;
  Object.assign(live, { stopReason: stopReason ?? 'max-steps', stopDetail, crashes: [...monitor.crashes] });
  return live;
}
