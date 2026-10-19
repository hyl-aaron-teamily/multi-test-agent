// Bounded, state-driven AI exploration of one installed app.
//   per step: ensure foreground → observe elements → fingerprint state → pick an untried, safe
//   element (navigation-looking first) → aiTap → check the logcat monitor → record the transition.
// Safety: elements whose label/description match `avoid` (payment, send, save, delete, logout…)
// are never touched, and inputs / switches are skipped unless allowMutation — so the explorer can run
// read-only against production apps.
// ref: midscene-example/android/javascript-sdk-demo/demo.ts (plain-script agent usage)
// ref: scripts/loop-android.ts (week-2 monitor + force-stop/launch pattern)
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AndroidAgent } from '@midscene/android';
import { adb, forceStopApp, launchApp } from '../core/adb';
import type { CrashEvent, LogcatMonitor } from '../core/logcat-monitor';
import { elementKey, type InteractiveElement, observeInteractiveElements } from './page-observer';
import { captureState, currentActivity, type FingerprintSource, StateTracker } from './state-tracker';

export type StepResult = 'navigated' | 'stayed' | 'app-exited' | 'crash' | 'error';

export interface TraceStep {
  step: number;
  at: string;
  stateId: string;
  stateTitle: string;
  stateFingerprintSource: FingerprintSource;
  activity: string;
  element: InteractiveElement | null;
  action: 'aiTap' | 'aiInput' | 'back' | 'relaunch';
  result: StepResult;
  skippedUnsafe?: string[];
  error?: string;
  crashDir?: string;
}

export interface ExploreOptions {
  packageName: string;
  udid?: string;
  maxSteps: number;
  failFast: boolean;
  /** Free text: what to prefer, e.g. "profile, agent". Also passed to aiQuery as context. */
  focus?: string;
  avoid: RegExp;
  allowMutation: boolean;
  maxRelaunches?: number;
  /** Max actions in one state before leaving it with BACK (keeps coverage broad). Default 5. */
  stateBudget?: number;
  /** Optional natural-language entry point tapped after every (re)launch, e.g. "the top-left avatar". */
  entry?: string;
}

export interface ExploreResult {
  steps: TraceStep[];
  crashes: CrashEvent[];
  stateCount: number;
  states: Record<string, string>;
  truncated: boolean;
  truncatedReason?: string;
}

export const DEFAULT_AVOID =
  /支付|付款|充值|购买|订阅|会员|钱包|红包|转账|发送|发消息|保存|提交|确认|确定|删除|移除|退出|注销|清空|清除|拨打|通话|举报|拉黑|分享|邀请|添加|安装|上传|创建|新建|编辑|修改|置顶|免打扰|关注|开关|启用|模板|建议|套餐|账单|赚钱|积分|联盟|计费|更改|更换|pay|purchase|buy|subscri|wallet|recharge|top.?up|send|save|submit|confirm|delete|remove|log.?out|sign.?out|clear|call|report|block|share|invite|install|add|upload|create|edit|pin|mute|follow|toggle|enable|template|suggest|prompt|billing|bplanb|credit|cash|earn|affiliate|change/i;

const NAV_HINT = /进入|打开|查看|详情|设置|更多|资料|主页|列表|open|view|detail|setting|more|profile|list|page|tab|navigate|go to/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Unsafe = matches the avoid pattern, or is an input / switch (state-changing) while mutation is off. Pure. */
export function isUnsafe(el: InteractiveElement, avoid: RegExp, allowMutation: boolean): boolean {
  if ((el.type === 'input' || el.type === 'switch') && !allowMutation) return true;
  return avoid.test(`${el.label} ${el.description}`);
}

/** Higher = explore first. Focus keywords > navigation hints > tabs/list rows > rest. Pure. */
export function scoreElement(el: InteractiveElement, focusTerms: string[]): number {
  const text = `${el.label} ${el.description}`.toLowerCase();
  let s = 0;
  if (focusTerms.some((t) => text.includes(t))) s += 4;
  if (NAV_HINT.test(text)) s += 2;
  if (el.type === 'tab' || el.type === 'list-item') s += 1;
  return s;
}

async function isForeground(pkg: string, udid?: string): Promise<boolean> {
  return (await currentActivity(udid)).startsWith(`${pkg}/`);
}

export async function relaunch(pkg: string, udid?: string): Promise<void> {
  await forceStopApp(pkg, udid);
  await launchApp(pkg, udid);
  await sleep(5_000);
}

/** Crash scenes are written up to ~3s after the first FATAL line; give an in-flight capture time. */
async function crashedSince(monitor: LogcatMonitor, before: number): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (monitor.crashes.length > before) return true;
    await sleep(500);
  }
  return monitor.crashes.length > before;
}

export async function exploreApp(agent: AndroidAgent, monitor: LogcatMonitor, opts: ExploreOptions): Promise<ExploreResult> {
  const { packageName: pkg, udid } = opts;
  const tracker = new StateTracker();
  const focusTerms = (opts.focus ?? '').toLowerCase().split(/[,，\s/|]+/).filter(Boolean);
  const steps: TraceStep[] = [];
  const maxRelaunches = opts.maxRelaunches ?? 3;
  const stateBudget = opts.stateBudget ?? 5;
  const actionsInState = new Map<string, number>();
  let relaunches = 0;
  let truncatedReason: string | undefined;

  const start = async () => {
    await relaunch(pkg, udid);
    if (opts.entry) {
      await agent.aiTap(opts.entry).catch((e: Error) => console.warn(`[explore] entry tap failed: ${e.message.split('\n')[0]}`));
      await sleep(2_000);
    }
  };
  await start();

  for (let step = 1; step <= opts.maxSteps; step++) {
    const at = new Date().toISOString();
    monitor.setContext({ iteration: step, step: `explore step ${step}` });

    // 1. App must be in the foreground; otherwise relaunch (bounded).
    if (!(await isForeground(pkg, udid))) {
      if (relaunches >= maxRelaunches) {
        truncatedReason = `app left the foreground more than ${maxRelaunches} times; exploration truncated`;
        break;
      }
      relaunches++;
      await start();
      steps.push({ step, at, stateId: '-', stateTitle: '', stateFingerprintSource: 'screenshot-hash', activity: '', element: null, action: 'relaunch', result: 'navigated' });
      console.log(`[explore] step ${step}: app not in foreground → relaunched (${relaunches}/${maxRelaunches})`);
      continue;
    }

    // 2-3. Observe + fingerprint.
    let elements: InteractiveElement[] = [];
    try {
      elements = await observeInteractiveElements(agent, opts.focus ? `the tester mainly cares about: ${opts.focus}` : undefined);
    } catch (err) {
      console.warn(`[explore] aiQuery failed: ${(err as Error).message.split('\n')[0]}`);
    }
    const state = await captureState(udid, agent, elements);
    tracker.see(state.stateId, state.title);

    // 4. Untried + safe, best first.
    const untried = tracker.unexplored(state.stateId, elements);
    const unsafe = untried.filter((e) => isUnsafe(e, opts.avoid, opts.allowMutation));
    for (const e of unsafe) tracker.markExplored(state.stateId, elementKey(e));
    const candidates = untried
      .filter((e) => !unsafe.includes(e))
      .sort((a, b) => scoreElement(b, focusTerms) - scoreElement(a, focusTerms));
    const spent = actionsInState.get(state.stateId) ?? 0;
    actionsInState.set(state.stateId, spent + 1);
    // Over budget → treat as exhausted so we go BACK and look elsewhere.
    const el = spent < stateBudget ? candidates[0] : undefined;

    // Previous step's real outcome: did we end up in a different state?
    const prev = steps[steps.length - 1];
    if (prev && (prev.result === 'navigated' || prev.result === 'stayed') && prev.stateId !== '-') {
      prev.result = prev.stateId === state.stateId ? 'stayed' : 'navigated';
    }

    const record: TraceStep = {
      step,
      at,
      stateId: state.stateId,
      stateTitle: state.title,
      stateFingerprintSource: state.source,
      activity: state.activity,
      element: el ?? null,
      action: el ? (el.type === 'input' ? 'aiInput' : 'aiTap') : 'back',
      result: 'stayed',
      ...(unsafe.length ? { skippedUnsafe: unsafe.map((e) => e.label) } : {}),
    };
    const crashesBefore = monitor.crashes.length;

    try {
      if (!el) {
        // 5. Nothing left in this state → leave it with BACK.
        await adb(['shell', 'input', 'keyevent', '4'], udid);
      } else {
        // 6-7. Act on the best candidate.
        tracker.markExplored(state.stateId, elementKey(el));
        const locate = `the ${el.type} "${el.label}"${el.description ? ` (${el.description})` : ''}`;
        if (el.type === 'input') await agent.aiInput(locate, { value: 'test' });
        else await agent.aiTap(locate);
      }
    } catch (err) {
      record.result = 'error';
      record.error = (err as Error).message.split('\n')[0];
    }

    // 8-9. Outcome: crash > exited > navigated/stayed.
    await sleep(2_000);
    if (await crashedSince(monitor, crashesBefore)) {
      const crash = monitor.crashes[monitor.crashes.length - 1];
      record.result = 'crash';
      record.crashDir = crash.dir;
      await writeFile(join(crash.dir, 'trace.json'), JSON.stringify({ source: 'ai-explore', package: pkg, steps: [...steps, record] }, null, 2));
    } else if (!(await isForeground(pkg, udid))) {
      record.result = 'app-exited';
    } else if (record.result !== 'error') {
      // Provisional; corrected at the next observation by comparing state IDs.
      record.result = 'navigated';
    }
    steps.push(record);
    console.log(
      `[explore] step ${step} [${state.stateId} "${state.title}"] ${record.action}${el ? ` "${el.label}"` : ''} → ${record.result}` +
        (record.skippedUnsafe ? `  (skipped unsafe: ${record.skippedUnsafe.join(', ')})` : '') +
        (record.error ? `  error: ${record.error}` : ''),
    );
    if (record.result === 'crash' && opts.failFast) {
      truncatedReason = 'FAIL_FAST: stopped at first crash';
      break;
    }
  }

  return {
    steps,
    crashes: [...monitor.crashes],
    stateCount: tracker.stateCount,
    states: Object.fromEntries(tracker.titles),
    truncated: !!truncatedReason,
    truncatedReason,
  };
}
