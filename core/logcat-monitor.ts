// Live logcat crash monitor: streams `adb logcat`, detects FATAL EXCEPTION / ANR / crash buffer
// markers, and saves a crash scene to midscene_run/crashes/<timestamp>/:
//   screenshot.png   — adb exec-out screencap -p at detection time
//   logcat.txt       — 200 lines before + up to 200 lines after the hit, plus `logcat -b crash -d`
//   context.json     — iteration, udid, current step, timestamp, matched keyword(s)
// ref: none in ref/ (no logcat monitor there); keyword set from dev-week1-milestone2.md Step 4,
//      detection idea after kaeawc/auto-mobile LogcatCrashDetector (design only, no dependency).
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { dumpCrashBuffer, screencap, spawnAdb } from './adb';

export type CrashKeyword = 'FATAL EXCEPTION' | 'ANR in' | 'beginning of crash';

const CRASH_KEYWORDS: CrashKeyword[] = ['FATAL EXCEPTION', 'ANR in', 'beginning of crash'];
const LINES_BEFORE = 200;
const LINES_AFTER = 200;
/** How long to keep collecting "after" lines once a crash is seen. */
const AFTER_WINDOW_MS = 3_000;

/** Returns the crash keyword in a logcat line, if any. Pure, exported for tests. */
export function detectCrashSignal(line: string): CrashKeyword | undefined {
  return CRASH_KEYWORDS.find((k) => line.includes(k));
}

/** Mutable context the test/loop updates so a crash can be tied to where it happened. */
export interface CrashRunContext {
  iteration?: number;
  step?: string;
}

export interface CrashEvent {
  dir: string;
  timestamp: string;
  keywords: CrashKeyword[];
  /** True if a `Process: <packageName>` line was seen near the hit (always true without packageName). */
  matchesPackage: boolean;
  firstLine: string;
  context: CrashRunContext & { udid?: string; packageName?: string };
  files: string[];
}

export interface LogcatMonitorOptions {
  udid?: string;
  /** Used as context: marks whether the crash belongs to this app (`Process: <pkg>`). */
  packageName?: string;
  /** Root folder for crash scenes. Default: midscene_run/crashes */
  outputDir?: string;
  onCrash?: (event: CrashEvent) => void | Promise<void>;
  /** Test seam: read lines from this stream instead of spawning `adb logcat`. */
  source?: Readable;
  /** Test seam: replace screencap / crash-buffer dump. */
  captureScreenshot?: () => Promise<Buffer>;
  dumpCrashBuffer?: () => Promise<string>;
}

export interface LogcatMonitor {
  readonly crashes: CrashEvent[];
  /** Update iteration / step so the next crash scene records them. */
  setContext(ctx: CrashRunContext): void;
  /** Wait for in-flight captures, end the logcat child process. */
  stop(): Promise<void>;
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function startLogcatMonitor(options: LogcatMonitorOptions = {}): LogcatMonitor {
  const outputRoot = resolve(options.outputDir ?? 'midscene_run/crashes');
  const shot = options.captureScreenshot ?? (() => screencap(options.udid));
  const dump = options.dumpCrashBuffer ?? (() => dumpCrashBuffer(options.udid));
  const processMarker = options.packageName ? `Process: ${options.packageName}` : undefined;

  // Main + system + crash buffers, only new lines (-T 1), with timestamps.
  const child = options.source
    ? undefined
    : spawnAdb(['logcat', '-v', 'time', '-b', 'main', '-b', 'system', '-b', 'crash', '-T', '1'], options.udid);
  const stream = options.source ?? child!.stdout;
  child?.stderr.on('data', () => {}); // drain; errors surface through child 'error'
  child?.on('error', (err) => console.error(`[logcat] adb logcat failed: ${err.message}`));

  const before: string[] = [];
  const crashes: CrashEvent[] = [];
  const pending: Promise<void>[] = [];
  let context: CrashRunContext = {};
  let active:
    | { hitLine: string; keywords: Set<CrashKeyword>; after: string[]; before: string[]; seenProcess: boolean; screenshot: Promise<Buffer | undefined>; timer: NodeJS.Timeout; done: () => void; at: Date }
    | undefined;

  const finish = async () => {
    const cur = active;
    if (!cur) return;
    active = undefined;
    clearTimeout(cur.timer);
    const timestamp = stamp(cur.at);
    const dir = join(outputRoot, timestamp);
    await mkdir(dir, { recursive: true });
    const files: string[] = [];

    const png = await cur.screenshot;
    if (png) {
      await writeFile(join(dir, 'screenshot.png'), png);
      files.push('screenshot.png');
    }

    const crashBuffer = await dump().catch((e: Error) => `<logcat -b crash -d failed: ${e.message}>`);
    const logcat = [
      `# ${LINES_BEFORE} lines before / up to ${LINES_AFTER} lines after the first crash line`,
      ...cur.before,
      ...cur.after,
      '',
      '# ---- adb logcat -b crash -d ----',
      crashBuffer,
    ].join('\n');
    await writeFile(join(dir, 'logcat.txt'), logcat);
    files.push('logcat.txt');

    const event: CrashEvent = {
      dir,
      timestamp: cur.at.toISOString(),
      keywords: [...cur.keywords],
      matchesPackage: processMarker ? cur.seenProcess : true,
      firstLine: cur.hitLine,
      context: { ...context, udid: options.udid, packageName: options.packageName },
      files: [...files, 'context.json'],
    };
    await writeFile(
      join(dir, 'context.json'),
      JSON.stringify(
        {
          iteration: event.context.iteration ?? null,
          udid: options.udid ?? null,
          packageName: options.packageName ?? null,
          step: event.context.step ?? null,
          timestamp: event.timestamp,
          keywords: event.keywords,
          matchesPackage: event.matchesPackage,
          firstLine: event.firstLine,
        },
        null,
        2,
      ),
    );
    crashes.push(event);
    await options.onCrash?.(event);
    cur.done();
  };

  const onLine = (line: string) => {
    if (active) {
      active.after.push(line);
      const kw = detectCrashSignal(line);
      if (kw) active.keywords.add(kw);
      if (processMarker && line.includes(processMarker)) active.seenProcess = true;
      if (active.after.length >= LINES_AFTER) void finish();
      return;
    }

    const kw = detectCrashSignal(line);
    if (kw) {
      let done!: () => void;
      const captured = new Promise<void>((r) => (done = r));
      pending.push(captured);
      active = {
        hitLine: line,
        keywords: new Set([kw]),
        before: before.slice(-LINES_BEFORE),
        after: [line],
        seenProcess: !!processMarker && line.includes(processMarker),
        // Screenshot right away: the crash dialog / dead screen is the evidence.
        screenshot: shot().catch(() => undefined),
        timer: setTimeout(() => void finish(), AFTER_WINDOW_MS),
        done,
        at: new Date(),
      };
    }
    before.push(line);
    if (before.length > LINES_BEFORE) before.shift();
  };

  const rl = createInterface({ input: stream });
  rl.on('line', onLine);
  const ended = new Promise<void>((r) => rl.once('close', () => r()));

  return {
    crashes,
    setContext(ctx) {
      context = { ...context, ...ctx };
    },
    async stop() {
      if (options.source) await ended; // test streams end on their own
      await finish();
      await Promise.all(pending);
      rl.close();
      child?.kill();
    },
  };
}
