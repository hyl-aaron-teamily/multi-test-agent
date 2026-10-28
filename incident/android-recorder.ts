// Android flight recorder (always on, ring buffers):
//   video : scrcpy segments 30 s × 6 (≈180 s), device-side graceful stop; screenrecord fallback
//   logs  : every logcat line host-timestamped, kept by TIME (180 s), not by line count
//   clock : device/host offset measured by `date +%s%3N` round trip midpoint
// capture() adds the black-box state available at trigger time: crash buffer, dropbox, foreground
// activity, meminfo, app version, device model / OS.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adb } from '../core/adb';
import { ScreenRecorder } from '../core/screen-recorder';

export const WINDOW_MS = 180_000;

export interface LogLine {
  at: number;
  line: string;
}

export class AndroidFlightRecorder {
  readonly video: ScreenRecorder;
  private logs: LogLine[] = [];
  clockOffsetMs = 0;

  constructor(
    readonly udid: string,
    readonly packageName: string,
    workDir: string,
  ) {
    this.video = new ScreenRecorder({ udid, workDir, segmentSec: 30, keep: 6 });
  }

  /** Feed from the driver's logcat stream (onLog). Trims by time so a long loop does not grow memory. */
  onLog = (at: number, line: string): void => {
    this.logs.push({ at, line });
    if (this.logs.length % 500 === 0) {
      const cut = Date.now() - WINDOW_MS;
      const i = this.logs.findIndex((l) => l.at >= cut);
      if (i > 0) this.logs.splice(0, i);
    }
  };

  get bufferedLines(): number {
    return this.logs.length;
  }

  async measureClock(): Promise<number> {
    const t0 = Date.now();
    const dev = Number((await adb(['shell', 'date', '+%s%3N'], this.udid)).trim());
    const t1 = Date.now();
    this.clockOffsetMs = Number.isFinite(dev) ? dev - Math.round((t0 + t1) / 2) : 0;
    return this.clockOffsetMs;
  }

  async start(): Promise<void> {
    await adb(['logcat', '-c'], this.udid).catch(() => {});
    await this.measureClock().catch(() => {});
    this.video.start();
  }

  window(from: number, to: number): LogLine[] {
    return this.logs.filter((l) => l.at >= from && l.at <= to);
  }

  /** Write video segments + logs + state into `dir`. Returns metadata for incident.json. */
  async capture(dir: string, at: number): Promise<{ videos: { name: string; startedAt: number; endedAt: number }[]; logFrom: number; logTo: number; state: Record<string, string> }> {
    await mkdir(join(dir, 'video'), { recursive: true });
    await mkdir(join(dir, 'logs'), { recursive: true });
    await mkdir(join(dir, 'state'), { recursive: true });
    // Let the trailing logs (stack traces) arrive, then cut the video.
    await new Promise((r) => setTimeout(r, 1500));
    const videos = await this.video.snapshotTimed(join(dir, 'video'));
    const logTo = Date.now();
    const logFrom = Math.max(at - WINDOW_MS, videos[0]?.startedAt ?? at - WINDOW_MS);
    const lines = this.window(logFrom, logTo);
    await writeFile(join(dir, 'logs', 'logcat-window.txt'), lines.map((l) => `${new Date(l.at).toISOString()} ${l.line}`).join('\n'));
    const sh = (args: string[], t = 30_000) => adb(args, this.udid, t).catch((e) => `(failed: ${(e as Error).message.split('\n')[0]})`);
    await writeFile(join(dir, 'logs', 'crash-buffer.txt'), await sh(['logcat', '-b', 'crash', '-d', '-v', 'threadtime']));
    await writeFile(join(dir, 'logs', 'dropbox.txt'), await sh(['shell', 'dumpsys', 'dropbox', '--print', 'data_app_crash', 'data_app_anr', 'data_app_native_crash', 'system_app_crash'], 60_000));
    const activity = (await sh(['shell', 'dumpsys', 'activity', 'activities'])).split('\n').filter((l) => /mResumedActivity|topResumedActivity|mFocusedApp/.test(l)).join('\n');
    await writeFile(join(dir, 'state', 'activity.txt'), activity);
    await writeFile(join(dir, 'state', 'meminfo.txt'), await sh(['shell', 'dumpsys', 'meminfo', this.packageName]));
    const version = (await sh(['shell', 'dumpsys', 'package', this.packageName])).match(/versionName=(\S+)/)?.[1] ?? '?';
    const model = (await sh(['shell', 'getprop', 'ro.product.model'])).trim();
    const os = (await sh(['shell', 'getprop', 'ro.build.version.release'])).trim();
    return { videos, logFrom, logTo, state: { appVersion: version, deviceModel: model, android: os, foreground: activity.trim().split('\n')[0]?.trim() ?? '' } };
  }

  async stop(): Promise<void> {
    await this.video.stop();
  }
}
