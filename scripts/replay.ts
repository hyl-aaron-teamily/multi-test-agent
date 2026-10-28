// Instant replay: re-run a replay bundle's ops (from the last launch to the finding) N times and
// check whether the crash / ANR / process exit happens again.
//
//   pnpm autotest replay midscene_run/missions/<id>/replay-1/replay.json --times 3
//   --keep-timing      wait until each op's original offset (default: run back-to-back, 1.5 s apart)
//   --device <udid>
//
// Writes replay-result.json next to the bundle (+ per-attempt videos when a recorder is available).
// Exit code: 1 = reproduced at least once, 0 = not reproduced, 2 = usage / setup error.
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { adb } from '../core/adb';
import { startLogcatMonitor } from '../core/logcat-monitor';
import { currentActivity } from '../explore/state-tracker';
import { createAndroidAgent } from '../fixtures/android';
import { executeOp, type ReplayBundle } from '../replay/ops';
import { ScreenRecorder } from '../core/screen-recorder';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { times: { type: 'string', short: 'n' }, 'keep-timing': { type: 'boolean' }, device: { type: 'string', short: 'd' } },
});

const file = positionals[0];
const times = Number(values.times ?? 3);
if (!file || !Number.isInteger(times) || times < 1) {
  console.error('Usage: pnpm autotest replay <replay.json> [--times 3] [--keep-timing] [--device <udid>]');
  process.exit(2);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Attempt {
  attempt: number;
  reproduced: boolean;
  signal: string | null;
  atOp: number | null;
  crashDir: string | null;
  failedOps: number;
  videos: string[];
  durationSec: number;
}

async function main() {
  const bundlePath = resolve(file!);
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as ReplayBundle;
  const pkg = bundle.packageName;
  const dir = dirname(bundlePath);
  const crashLike = ['crash', 'anr', 'app-exit'].includes(bundle.finding.kind);
  console.log(`[replay] ${bundle.finding.title} — ${bundle.ops.length} ops × ${times}`);
  if (!crashLike) console.log(`[replay] note: finding kind "${bundle.finding.kind}" is not a crash; replay re-runs the path, judge the end screen by its screenshots`);

  const { agent, udid } = await createAndroidAgent(values.device ?? bundle.udid ?? undefined, {
    groupName: `Replay: ${bundle.finding.title}`,
    reportFileName: `replay-${bundle.missionId}`,
    cache: { id: `replay-${pkg}`, strategy: 'read-write' },
  });
  const monitor = startLogcatMonitor({ udid, packageName: pkg, extraContext: { source: 'replay', bundle: bundlePath } });
  const attempts: Attempt[] = [];

  for (let a = 1; a <= times; a++) {
    const recorder = process.env.MISSION_RECORD === 'off' ? undefined : new ScreenRecorder({ udid, workDir: join(dir, `.rec-${a}`) });
    recorder?.start();
    const t0 = Date.now();
    const before = monitor.crashes.length;
    const res: Attempt = { attempt: a, reproduced: false, signal: null, atOp: null, crashDir: null, failedOps: 0, videos: [], durationSec: 0 };
    console.log(`\n[replay] attempt ${a}/${times}`);
    for (const [i, r] of bundle.ops.entries()) {
      if (values['keep-timing']) await sleep(Math.max(0, r.t - (Date.now() - t0)));
      try {
        await executeOp(agent, r.op, pkg, udid);
      } catch (err) {
        res.failedOps++;
        console.log(`[replay]   #${i + 1} ${r.label.slice(0, 80)} ✗ ${(err as Error).message.split('\n')[0].slice(0, 120)}`);
      }
      await sleep(1_500);
      const fresh = monitor.crashes.slice(before).filter((c) => c.matchesPackage);
      const alive = (await adb(['shell', 'pidof', pkg], udid).catch(() => '')).trim();
      const exited = r.op.kind !== 'launch' && !alive && !(await currentActivity(udid)).startsWith(`${pkg}/`);
      if (fresh.length || exited) {
        Object.assign(res, {
          reproduced: true,
          signal: fresh.length ? fresh[0].keywords.join('+') : 'process exited without crash log',
          atOp: i + 1,
          crashDir: fresh[0]?.dir ?? null,
        });
        console.log(`[replay]   ⚠ reproduced at op #${i + 1} (${res.signal})`);
        break;
      }
    }
    if (recorder) {
      if (res.reproduced) res.videos = (await recorder.snapshot(join(dir, `attempt-${a}`))).map((v) => `attempt-${a}/${v}`);
      await recorder.stop();
    }
    res.durationSec = Math.round((Date.now() - t0) / 1000);
    attempts.push(res);
  }
  await monitor.stop();
  await agent.flushCache().catch(() => {});
  await agent.destroy().catch(() => {});

  const hits = attempts.filter((x) => x.reproduced).length;
  const summary = {
    bundle: bundlePath,
    finding: bundle.finding,
    times,
    reproduced: hits,
    rate: `${hits}/${times}`,
    conclusion: hits
      ? `复现 ${hits}/${times} 次`
      : crashLike
        ? `未复现（0/${times}）：偶发问题，可加大 --times 或使用 --keep-timing 保留原始节奏`
        : `已按原路径重放 ${times} 次；非崩溃类问题请对照截图确认`,
    attempts,
    finishedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, 'replay-result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n[replay] ${summary.conclusion}`);
  console.log(`[replay] result → ${join(dir, 'replay-result.json')}`);
  process.exitCode = hits ? 1 : 0;
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(2);
});
