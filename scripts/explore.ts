// `autotest explore local "<goal>"` — the exploration tier (capability ②) in this process, without the platform
// (development). Through the platform: `autotest explore run "<goal>"` (= task run --explore), MCP explore_run.
//   pnpm autotest explore local "看看个人主页的通知铃铛能不能打开" [--mode task|explore] [--surface android-app|desktop-web|…]
//        [--env prod|test] [--device <udid>] [--writable] [--max-steps N] [--max-minutes M] [--headed]
import 'dotenv/config';
import { resolve } from 'node:path';
import { runAgent } from '../engine/agent/run';
import type { Env, Surface } from '../platform/accounts/types';
import { openPools } from '../platform/pools';

const flag = (a: string[], k: string) => {
  const i = a.indexOf(`--${k}`);
  return i >= 0 ? a[i + 1] : undefined;
};

export async function exploreCmd(args: string[]): Promise<number> {
  const [sub, goal] = args;
  if (sub !== 'local' || !goal) {
    console.error('Usage: autotest explore local "<goal>" [--mode task|explore] [--surface <s>] [--env prod|test] [--device <udid>] [--writable] [--max-steps N] [--max-minutes M] [--headed]');
    return 40;
  }
  const { pool, devices } = await openPools();
  const surface = (flag(args, 'surface') ?? 'android-app') as Surface;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const r = await runAgent({
    goal,
    mode: (flag(args, 'mode') ?? 'explore') === 'task' ? 'task' : 'explore',
    surface,
    env: (flag(args, 'env') ?? 'prod') as Env,
    pool,
    devices,
    udid: flag(args, 'device'),
    writable: args.includes('--writable'),
    maxSteps: flag(args, 'max-steps') ? Number(flag(args, 'max-steps')) : undefined,
    maxMinutes: flag(args, 'max-minutes') ? Number(flag(args, 'max-minutes')) : undefined,
    headed: args.includes('--headed'),
    runDir: resolve('midscene_run/explore', `${surface}-${stamp}`),
  });
  console.log(`[explore] ${r.status}: ${r.summary} — findings ${r.findings.filter((f) => f.counted).length}, screens ${r.coverage.screens}, actions ${r.coverage.actions}, blocked ${r.blocked.length}, ${r.usage.steps} steps / ${r.usage.seconds} s / ${r.usage.modelCalls} model calls → ${r.runDir}`);
  return r.status === 'error' ? 60 : r.status === 'env-unfit' ? 50 : 0;
}

if (process.argv[1] && /explore\.ts$/.test(process.argv[1])) exploreCmd(process.argv.slice(2)).then((c) => process.exit(c));
