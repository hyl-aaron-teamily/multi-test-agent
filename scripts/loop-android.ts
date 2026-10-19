// High-frequency stability loop: run the same Android flow N times, force-stopping the app at
// the start of every iteration, while the logcat monitor watches for crashes.
//
//   pnpm loop:android                      # 10 iterations of Settings → About phone
//   pnpm loop:android --count 50           # or LOOP_COUNT=50
//   APP_PACKAGE=com.example.app pnpm loop:android
//   FAIL_FAST=true                         # stop at the first captured crash
//   CRASH_AT_ITERATION=3                   # crash-monitor self-check: `adb shell am crash <pkg>`
//                                          # mid-flow on iteration 3 to prove capture works
//   FLOW=launch / --flow launch            # no AI: force-stop + launch + foreground check only
//                                          # (runs without model credentials)
//
// Writes midscene_run/loop-summary.json and prints it.
// A standalone script (not a Vitest spec) so long loops do not block the test report.
// ref: midscene-example/android/javascript-sdk-demo/demo.ts (plain-script Android agent usage)
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { AndroidAgent } from '@midscene/android';
import { SETTINGS_PACKAGE, runSettingsAboutFlow, type StepRunner } from '../android/flows/settings-about';
import { adb } from '../core/adb';
import { type CrashEvent, startLogcatMonitor } from '../core/logcat-monitor';
import { createAndroidAgent, forceStopApp, getAndroidDevice, launchApp } from '../fixtures/android';

const { values } = parseArgs({
  options: {
    count: { type: 'string', short: 'n' },
    package: { type: 'string', short: 'p' },
    device: { type: 'string', short: 'd' },
    'fail-fast': { type: 'boolean' },
    flow: { type: 'string' },
  },
});

const loopCount = Number(values.count ?? process.env.LOOP_COUNT ?? 10);
const appPackage = values.package ?? process.env.APP_PACKAGE ?? SETTINGS_PACKAGE;
const deviceId = values.device ?? process.env.DEVICE_ID?.trim() ?? undefined;
const failFast = values['fail-fast'] ?? process.env.FAIL_FAST === 'true';
const crashAt = process.env.CRASH_AT_ITERATION ? Number(process.env.CRASH_AT_ITERATION) : undefined;
const flow = (values.flow ?? process.env.FLOW ?? 'ai') as 'ai' | 'launch';
const SUMMARY_FILE = resolve('midscene_run/loop-summary.json');

if (flow !== 'ai' && flow !== 'launch') {
  console.error(`FLOW / --flow must be "ai" or "launch", got "${flow}"`);
  process.exit(2);
}
if (!Number.isInteger(loopCount) || loopCount < 1) {
  console.error(`LOOP_COUNT / --count must be a positive integer, got "${values.count ?? process.env.LOOP_COUNT}"`);
  process.exit(2);
}

interface IterationResult {
  iteration: number;
  status: 'passed' | 'failed';
  error?: string;
  crashDirs: string[];
  durationMs: number;
}

/** Any app other than Settings: just confirm it is up and not showing a crash dialog. */
async function runSmokeFlow(agent: AndroidAgent, step: StepRunner): Promise<void> {
  await step('1. App is in the foreground', async () => {
    await agent.aiAssert(`The app ${appPackage} is open and no "app has stopped" / "isn't responding" dialog is shown`);
  });
}

/** FLOW=launch: no AI, just confirm the app reached the foreground after launch. */
async function runLaunchCheck(step: StepRunner, udid: string): Promise<void> {
  await step('1. App reached the foreground', async () => {
    await new Promise((r) => setTimeout(r, 3_000));
    const activities = await adb(['shell', 'dumpsys', 'activity', 'activities'], udid);
    const top = activities.split('\n').find((l) => /topResumedActivity|mResumedActivity/.test(l)) ?? '';
    if (!top.includes(appPackage)) throw new Error(`${appPackage} is not the resumed activity: ${top.trim() || '<none>'}`);
  });
}

async function writeSummary(summary: object) {
  await mkdir(resolve('midscene_run'), { recursive: true });
  await writeFile(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`summary → ${SUMMARY_FILE}`);
}

async function main() {
  const startedAt = new Date().toISOString();
  let agent: AndroidAgent | undefined;
  let udid: string;
  try {
    if (flow === 'launch') {
      udid = deviceId ?? (await getAndroidDevice()).udid;
    } else {
      const ctx = await createAndroidAgent(deviceId, {
        groupName: `Android loop: ${appPackage}`,
        reportFileName: `android-loop-${appPackage}-${Date.now()}`,
      });
      agent = ctx.agent;
      udid = ctx.udid;
    }
  } catch (err) {
    console.error((err as Error).message);
    await writeSummary({
      startedAt,
      appPackage,
      flow,
      totalRuns: 0,
      crashesDetected: 0,
      failedRuns: 0,
      firstCrashIteration: null,
      aborted: (err as Error).message,
    });
    process.exit(1);
  }
  console.log(`[loop] device ${udid}, package ${appPackage}, flow=${flow}, ${loopCount} iterations, failFast=${failFast}`);

  const crashes: CrashEvent[] = [];
  const monitor = startLogcatMonitor({
    udid,
    packageName: appPackage,
    onCrash: (e) => {
      crashes.push(e);
      console.warn(`[loop] crash captured (${e.keywords.join(', ')}) at iteration ${e.context.iteration} → ${e.dir}`);
    },
  });

  const results: IterationResult[] = [];
  let currentIteration = 0;
  const step: StepRunner = async (name, body) => {
    monitor.setContext({ iteration: currentIteration, step: name });
    console.log(`[loop #${currentIteration}] ${name}`);
    return body();
  };

  try {
    for (let i = 1; i <= loopCount; i++) {
      currentIteration = i;
      const t0 = Date.now();
      const crashesBefore = crashes.length;
      monitor.setContext({ iteration: i, step: 'force-stop + launch' });
      let error: string | undefined;
      try {
        // Clean state every round.
        await forceStopApp(appPackage, udid);
        await launchApp(appPackage, udid);
        if (crashAt === i) {
          // Self-check for the crash monitor: kill the app mid-flow the way a real crash would.
          setTimeout(() => {
            console.warn(`[loop #${i}] CRASH_AT_ITERATION: adb shell am crash ${appPackage}`);
            adb(['shell', 'am', 'crash', appPackage], udid).catch((e) => console.error(`am crash failed: ${e.message}`));
          }, 3_000);
        }
        if (!agent) await runLaunchCheck(step, udid);
        else if (appPackage === SETTINGS_PACKAGE) await runSettingsAboutFlow(agent, step, udid);
        else await runSmokeFlow(agent, step);
      } catch (err) {
        error = (err as Error).message;
        console.error(`[loop #${i}] failed: ${error}`);
      }
      // Give the monitor a moment to finish writing a crash scene from this round.
      await new Promise((r) => setTimeout(r, 1_500));
      const newCrashes = crashes.slice(crashesBefore);
      results.push({
        iteration: i,
        status: error || newCrashes.length ? 'failed' : 'passed',
        error,
        crashDirs: newCrashes.map((c) => c.dir),
        durationMs: Date.now() - t0,
      });
      if (failFast && newCrashes.length) {
        console.warn(`[loop] FAIL_FAST: stopping after crash at iteration ${i}`);
        break;
      }
    }
  } finally {
    await monitor.stop();
    await agent?.destroy();
  }

  const firstCrash = crashes[0];
  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    udid,
    appPackage,
    flow,
    requestedRuns: loopCount,
    totalRuns: results.length,
    crashesDetected: crashes.length,
    failedRuns: results.filter((r) => r.status === 'failed').length,
    firstCrashIteration: firstCrash?.context.iteration ?? null,
    crashDirs: crashes.map((c) => c.dir),
    midsceneReport: agent?.reportFile ?? null,
    iterations: results,
  };
  await writeSummary(summary);
  process.exit(summary.failedRuns > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
