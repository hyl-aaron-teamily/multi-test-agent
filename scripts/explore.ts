// Path A — generic AI exploration of an installed app.
//
//   pnpm explore --package ai.teamily.mobile
//   pnpm explore --package <pkg> --steps 20 --focus "profile, agent"
//   EXPLORE_MAX_STEPS=50  FAIL_FAST=true  EXPLORE_FOCUS="..."  EXPLORE_ALLOW_MUTATION=true
//   EXPLORE_STATE_BUDGET=5  # actions per state before BACK
//   EXPLORE_ENTRY="the top-left avatar"  # tapped after every (re)launch; start exploring there
//   EXPLORE_AVOID="regex"   # extra pattern of labels never to touch (added to the built-in list)
//
// Output: midscene_run/explore-traces/<ts>.json, Midscene HTML report (per-step screenshots),
// crash scenes in midscene_run/crashes/<ts>/ (context.json source = "ai-explore").
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { startLogcatMonitor } from '../core/logcat-monitor';
import { DEFAULT_AVOID, exploreApp } from '../explore/explore-loop';
import { buildTrace, writeTrace } from '../explore/trace';
import { createAndroidAgent } from '../fixtures/android';
import { emitTaskResult } from '../core/task-result';

const { values } = parseArgs({
  options: {
    package: { type: 'string', short: 'p' },
    device: { type: 'string', short: 'd' },
    steps: { type: 'string', short: 'n' },
    focus: { type: 'string' },
    'fail-fast': { type: 'boolean' },
  },
});

const pkg = values.package ?? process.env.APP_PACKAGE;
const maxSteps = Number(values.steps ?? process.env.EXPLORE_MAX_STEPS ?? 50);
const failFast = values['fail-fast'] ?? process.env.FAIL_FAST === 'true';
const focus = values.focus ?? process.env.EXPLORE_FOCUS;
const extraAvoid = process.env.EXPLORE_AVOID?.trim();
const avoid = extraAvoid ? new RegExp(`${DEFAULT_AVOID.source}|${extraAvoid}`, 'i') : DEFAULT_AVOID;
const allowMutation = process.env.EXPLORE_ALLOW_MUTATION === 'true';
const entry = process.env.EXPLORE_ENTRY?.trim() || undefined;
const stateBudget = Number(process.env.EXPLORE_STATE_BUDGET ?? 5);

if (!pkg) {
  console.error('Usage: pnpm explore --package <installed.package.name>  (or APP_PACKAGE=...)');
  process.exit(2);
}
if (!Number.isInteger(maxSteps) || maxSteps < 1) {
  console.error(`EXPLORE_MAX_STEPS / --steps must be a positive integer, got "${values.steps ?? process.env.EXPLORE_MAX_STEPS}"`);
  process.exit(2);
}

async function main() {
  const startedAt = new Date().toISOString();
  const { agent, udid } = await createAndroidAgent(values.device ?? process.env.DEVICE_ID?.trim(), {
    groupName: `AI explore: ${pkg}`,
    reportFileName: `explore-${pkg}-${Date.now()}`,
  });
  const monitor = startLogcatMonitor({ udid, packageName: pkg, extraContext: { source: 'ai-explore' } });
  console.log(`[explore] ${pkg} on ${udid}, max ${maxSteps} steps, focus=${focus ?? '-'}, mutation=${allowMutation}`);

  let result;
  try {
    result = await exploreApp(agent, monitor, { packageName: pkg!, udid, maxSteps, failFast, focus, avoid, allowMutation, stateBudget, entry });
  } finally {
    await monitor.stop();
    await agent.destroy().catch(() => {});
  }

  const trace = buildTrace(result, { package: pkg!, udid, startedAt, maxSteps, focus, midsceneReport: agent.reportFile ?? null });
  const file = await writeTrace(trace);
  console.log(`\n[explore] steps=${trace.steps.length} states=${trace.stateCount} crashes=${trace.crashes.length} truncated=${trace.truncated}`);
  console.log(`[explore] ${trace.conclusion}`);
  console.log(`[explore] trace → ${file}`);
  emitTaskResult({ artifact: file, verdict: trace.conclusion });
  if (trace.midsceneReport) console.log(`[explore] midscene report → ${trace.midsceneReport}`);
  process.exitCode = trace.crashes.some((c) => c.matchesPackage) ? 1 : 0;
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
