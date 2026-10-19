// Multi-round Monkey: one seed per round, every seed + repro command written to
// monkey_run/summary.json so any crash can be replayed with the same event stream.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { forceStopApp } from '../core/adb';
import { correlate, type CorrelatedCrash, parseMonkeyLogFile } from './log-parser';
import { randomSeed, runMonkey } from './runner';

export const MONKEY_RUN_DIR = resolve('monkey_run');

export interface MonkeyRoundSummary {
  round: number;
  seed: number;
  eventCount: number;
  eventsInjected: number | null;
  exitCode: number | null;
  crashesDetected: number;
  firstCrashEventCount: number | null;
  logPath: string;
  crashArtifactDirs: string[];
  correlated: CorrelatedCrash[];
  reproduceCommand: string;
  durationMs: number;
}

export interface MonkeySummary {
  package: string;
  source: 'monkey';
  deviceId: string | null;
  startedAt: string;
  finishedAt: string;
  throttle: number;
  rounds: MonkeyRoundSummary[];
  conclusion: string;
  reproduceCommands: string[];
}

export interface MonkeyLoopOptions {
  packageName: string;
  deviceId?: string;
  seed?: number;
  eventCount: number;
  rounds: number;
  throttle: number;
  failFast: boolean;
  monitorNativeCrashes?: boolean;
}

export async function runMonkeyLoop(o: MonkeyLoopOptions): Promise<MonkeySummary> {
  const startedAt = new Date().toISOString();
  const rounds: MonkeyRoundSummary[] = [];
  await mkdir(MONKEY_RUN_DIR, { recursive: true });

  for (let round = 1; round <= Math.max(1, o.rounds); round++) {
    // Round 1 uses the given seed; later rounds derive one so the whole run stays reproducible.
    const seed = o.seed !== undefined ? o.seed + (round - 1) : randomSeed();
    const outputDir = join(MONKEY_RUN_DIR, `${startedAt.replace(/[:.]/g, '-')}-r${round}-s${seed}`);
    await forceStopApp(o.packageName, o.deviceId);
    const r = await runMonkey({ packageName: o.packageName, deviceId: o.deviceId, seed, eventCount: o.eventCount, throttle: o.throttle, outputDir, monitorNativeCrashes: o.monitorNativeCrashes });
    const parsed = await parseMonkeyLogFile(r.logPath);
    const own = r.crashes.filter((c) => c.matchesPackage);
    const correlated = correlate(own, parsed);
    const firstMonkey = parsed.signals.find((s) => s.eventCount !== null);
    const crashesDetected = Math.max(own.length, parsed.signals.filter((s) => !s.packageName || s.packageName === o.packageName).length);
    rounds.push({
      round,
      seed,
      eventCount: o.eventCount,
      eventsInjected: parsed.eventsInjected,
      exitCode: r.exitCode,
      crashesDetected,
      firstCrashEventCount: firstMonkey?.eventCount ?? null,
      logPath: r.logPath,
      crashArtifactDirs: r.crashArtifactDirs,
      correlated,
      reproduceCommand: r.reproduceCommand,
      durationMs: r.durationMs,
    });
    console.log(
      `[monkey] round ${round}: seed=${seed} injected=${parsed.eventsInjected ?? '?'} crashes=${crashesDetected}` +
        (parsed.aborted ? ' (monkey aborted)' : ''),
    );
    if (parsed.eventsInjected !== null && parsed.eventsInjected < o.eventCount && !crashesDetected) {
      console.warn(`[monkey] WARNING: only ${parsed.eventsInjected}/${o.eventCount} events injected — check ${r.logPath}`);
    }
    if (crashesDetected > 0 && o.failFast) break;
  }
  await forceStopApp(o.packageName, o.deviceId).catch(() => {});

  const total = rounds.reduce((n, r) => n + r.crashesDetected, 0);
  const summary: MonkeySummary = {
    package: o.packageName,
    source: 'monkey',
    deviceId: o.deviceId ?? null,
    startedAt,
    finishedAt: new Date().toISOString(),
    throttle: o.throttle,
    rounds,
    conclusion:
      total > 0
        ? `${total} crash/ANR captured; replay with the seed's reproduceCommand`
        : `未捕获崩溃 / no crash captured in ${rounds.length} round(s); seeds kept for replay`,
    reproduceCommands: rounds.map((r) => r.reproduceCommand),
  };
  const file = join(MONKEY_RUN_DIR, 'summary.json');
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);
  // Per-run copy so report:problems can pick older runs too.
  await writeFile(join(MONKEY_RUN_DIR, `summary-${startedAt.replace(/[:.]/g, '-')}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[monkey] ${summary.conclusion}`);
  for (const c of summary.reproduceCommands) console.log(`[monkey] repro: ${c}`);
  console.log(`[monkey] summary → ${file}`);
  return summary;
}
