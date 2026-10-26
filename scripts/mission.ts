// Natural-language test mission: plan → bounded execution → report.
//
//   pnpm mission "聊天时偶发闪退，你试试能不能重现" --package ai.teamily.mobile
//   pnpm mission "左侧栏新加了个功能，看看使用流畅度和功能完整性" --max-steps 60 --max-minutes 20
//   --plan-only                 # print the generated plan, do not touch the device
//   --keep-going                # do not stop at the first finding
//   --plan <plan.json>          # rerun a previous mission's exact plan (no re-planning; Midscene cache hits)
//
// Limits (both enforced): MISSION_MAX_STEPS / --max-steps, MISSION_MAX_MINUTES / --max-minutes.
// Defaults come from the plan (model suggestion), clamped by MISSION_STEP_CAP / MISSION_MINUTES_CAP.
// A watchdog aborts at the deadline and force-exits 2 minutes later if an AI call hangs, after
// writing whatever was collected.
// Output: midscene_run/missions/<id>/{mission.json, report.md, finding-*.png}; last line prints the report path.
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startLogcatMonitor } from '../core/logcat-monitor';
import { createAndroidAgent } from '../fixtures/android';
import { LIMIT_CAPS, type MissionPlan, planMission } from '../mission/planner';
import { type MissionRecord, verdictOf, writeMissionReport } from '../mission/report';
import { type MissionResult, runMission } from '../mission/runner';
import { ScreenRecorder } from '../core/screen-recorder';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    package: { type: 'string', short: 'p' },
    device: { type: 'string', short: 'd' },
    'max-steps': { type: 'string' },
    'max-minutes': { type: 'string' },
    'plan-only': { type: 'boolean' },
    'keep-going': { type: 'boolean' },
    id: { type: 'string' },
    hint: { type: 'string' },
    plan: { type: 'string' },
  },
});

const request = positionals.join(' ').trim() || process.env.MISSION_REQUEST?.trim() || (values.plan ? `(rerun of ${values.plan})` : undefined);
const pkg = values.package ?? process.env.APP_PACKAGE ?? 'ai.teamily.mobile';
const appHint = values.hint ?? process.env.APP_HINT ?? (pkg === 'ai.teamily.mobile' ? 'Teamily AI: instant messaging app with AI agents; bottom tabs 聊天/智能体/发现/记忆/成果, top-left avatar opens the profile' : undefined);
if (!request) {
  console.error('Usage: pnpm mission "<自然语言测试需求>" [--package <pkg>] [--max-steps N] [--max-minutes M] [--plan-only]');
  process.exit(2);
}

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
const userSteps = num(values['max-steps'] ?? process.env.MISSION_MAX_STEPS);
const userMinutes = num(values['max-minutes'] ?? process.env.MISSION_MAX_MINUTES);
for (const [k, v] of [['max-steps', userSteps], ['max-minutes', userMinutes]] as const) {
  if (v !== undefined && (!Number.isFinite(v) || v <= 0)) {
    console.error(`--${k} must be a positive number`);
    process.exit(2);
  }
}

async function main() {
  const id = values.id ?? `m-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = resolve('midscene_run/missions', id);
  await mkdir(dir, { recursive: true });
  const startedAt = new Date();
  console.log(`[mission] ${id}: 「${request}」 → ${pkg}`);

  const plan: MissionPlan = values.plan ? JSON.parse(await readFile(resolve(values.plan), 'utf8')) : await planMission(request!, { packageName: pkg, appHint });
  plan.maxSteps = Math.min(LIMIT_CAPS.maxSteps, userSteps ?? plan.maxSteps);
  plan.maxMinutes = Math.min(LIMIT_CAPS.maxMinutes, userMinutes ?? plan.maxMinutes);
  // Not inherited from a reused plan.json: only this run's flag decides.
  plan.stopOnFirstFinding = !values['keep-going'];
  await writeFile(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`[mission] plan (${plan.plannedBy}): ${plan.title} — intent=${plan.intent}, area=${plan.targetArea}, limits=${plan.maxSteps} steps / ${plan.maxMinutes} min`);
  if (values['plan-only']) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // Bound every aiAct's internal re-planning so one instruction cannot eat the whole budget.
  process.env.MIDSCENE_REPLANNING_CYCLE_LIMIT ??= '15';
  const deadline = startedAt.getTime() + plan.maxMinutes * 60_000;
  let aborted = false;
  let finalize: (() => Promise<void>) | undefined;
  const watchdog = setTimeout(() => {
    aborted = true;
    console.warn('[mission] deadline reached; waiting up to 2 min for the current action');
    setTimeout(async () => {
      console.error('[mission] hard timeout: current action did not return, writing partial report');
      result.stopReason = 'max-minutes';
      result.stopDetail = '看门狗：到达时长上限后当前动作 2 分钟仍未返回，强制结束（部分报告）';
      await finalize?.().catch(() => {});
      process.exit(3);
    }, 120_000).unref();
  }, plan.maxMinutes * 60_000);
  watchdog.unref();

  // Midscene plan/locate cache: rounds repeat the same entry + scenario prompts, so from round 2 on
  // (and on later runs of the same plan) those steps replay without model calls.
  const cacheId =
    process.env.MISSION_CACHE_ID ??
    `mission-${pkg}-${createHash('md5').update(JSON.stringify([plan.entryInstruction, plan.scenario])).digest('hex').slice(0, 10)}`;
  const useCache = process.env.MISSION_CACHE !== 'off';
  const { agent, udid } = await createAndroidAgent(values.device ?? process.env.DEVICE_ID?.trim(), {
    groupName: `Mission: ${plan.title}`,
    reportFileName: `mission-${id}`,
    ...(useCache ? { cache: { id: cacheId, strategy: 'read-write' as const } } : {}),
  });
  console.log(`[mission] cache ${useCache ? `on (id=${cacheId})` : 'off'}`);
  const monitor = startLogcatMonitor({ udid, packageName: pkg, extraContext: { source: 'mission', missionId: id, request } });
  // Dashcam for instant replay: newest segments are copied into each finding's replay bundle.
  const recorder =
    process.env.MISSION_RECORD === 'off'
      ? undefined
      : new ScreenRecorder({
          udid,
          workDir: join(dir, '.rec'),
          segmentSec: Number(process.env.MISSION_RECORD_SEGMENT ?? 30),
          keep: Number(process.env.MISSION_RECORD_KEEP ?? 3),
          engine: (process.env.MISSION_RECORDER as 'scrcpy' | 'screenrecord' | 'auto' | undefined) ?? 'auto',
        });
  recorder?.start();
  console.log(`[mission] recorder ${recorder ? recorder.describe() : 'off'}`);

  // Shared with the runner, so the hard-timeout path reports what was collected so far.
  let result: MissionResult = { steps: [], rounds: [], findings: [], stopReason: 'aborted', crashes: [] };
  const write = async () => {
    const finishedAt = new Date();
    const rec: MissionRecord = {
      id,
      request: request!,
      packageName: pkg,
      udid,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
      limits: { maxSteps: plan.maxSteps, maxMinutes: plan.maxMinutes, caps: LIMIT_CAPS },
      plan,
      result: { ...result, crashes: result.crashes.map((c) => ({ dir: c.dir, keywords: c.keywords, matchesPackage: c.matchesPackage, firstLine: c.firstLine })) },
      midsceneReport: agent.reportFile ?? null,
      verdict: verdictOf(result),
    };
    const file = await writeMissionReport(dir, rec);
    console.log(`\n[mission] ${rec.verdict}`);
    console.log(`[mission] report → ${file}`);
  };
  finalize = write;

  try {
    result = await runMission(agent, monitor, plan, { packageName: pkg, udid, outDir: dir, deadline, shouldAbort: () => aborted, live: result, recorder, missionId: id });
  } catch (err) {
    result.stopReason = 'error';
    result.stopDetail = (err as Error).message;
  } finally {
    clearTimeout(watchdog);
    await monitor.stop();
    await recorder?.stop();
  }
  await write();
  if (useCache) await agent.flushCache().catch((e: Error) => console.warn(`[mission] cache flush failed: ${e.message}`));
  await agent.destroy().catch(() => {});
  process.exitCode = result.findings.length ? 1 : 0;
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
