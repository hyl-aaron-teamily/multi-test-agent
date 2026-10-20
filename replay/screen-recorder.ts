// Ring screen recorder ("dashcam") for instant replay.
//   engine scrcpy       : host-side `scrcpy --no-playback --record seg.mkv --time-limit S` segments
//                         (mkv survives an abrupt stop; needs scrcpy on PATH or SCRCPY_PATH)
//   engine screenrecord : device-side `screenrecord --time-limit S /sdcard/autotest_rec_<k>.mp4`,
//                         no install needed (Android's own recorder, max 180 s per file)
// Keeps the newest `keep` segments; snapshot(dir) stops the current segment and copies the
// newest ones to `dir` — the video of the moments before a crash. Then recording resumes.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { adb, resolveAdbPath, spawnAdb } from '../core/adb';

export type RecorderEngine = 'scrcpy' | 'screenrecord';

export interface RecorderOptions {
  udid?: string;
  /** Seconds per segment. Default 30. */
  segmentSec?: number;
  /** Segments kept (ring size). Default 3 → up to ~90 s before an event. */
  keep?: number;
  /** Host directory for scrcpy segments. */
  workDir: string;
  engine?: RecorderEngine | 'auto';
}

/** scrcpy executable if available: SCRCPY_PATH, else `scrcpy` on PATH. */
export function findScrcpy(): string | undefined {
  const fromEnv = process.env.SCRCPY_PATH?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['scrcpy'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || undefined : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ScreenRecorder {
  readonly engine: RecorderEngine;
  private readonly scrcpy?: string;
  private readonly seg: number;
  private readonly keep: number;
  private running = false;
  private paused = false;
  private child?: ChildProcess;
  private k = 0;
  /** Finished segments, oldest first (host paths for scrcpy, device paths for screenrecord). */
  private readonly ring: string[] = [];
  private current?: string;
  private loop?: Promise<void>;

  constructor(private readonly o: RecorderOptions) {
    this.seg = o.segmentSec ?? 30;
    this.keep = o.keep ?? 3;
    this.scrcpy = o.engine === 'screenrecord' ? undefined : findScrcpy();
    this.engine = this.scrcpy && o.engine !== 'screenrecord' ? 'scrcpy' : 'screenrecord';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    await mkdir(this.o.workDir, { recursive: true });
    while (this.running) {
      if (this.paused) {
        await sleep(200);
        continue;
      }
      const slot = this.k++ % (this.keep + 1);
      const file = this.engine === 'scrcpy' ? join(resolve(this.o.workDir), `seg-${slot}.mkv`) : `/sdcard/autotest_rec_${slot}.mp4`;
      this.current = file;
      const startedAt = Date.now();
      await new Promise<void>((done) => {
        this.child =
          this.engine === 'scrcpy'
            ? spawn(
                this.scrcpy!,
                [...(this.o.udid ? ['-s', this.o.udid] : []), '--no-playback', '--no-window', '--no-audio', `--record=${file}`, `--time-limit=${this.seg}`, '--max-size=1280'],
                { env: { ...process.env, ADB: resolveAdbPath() }, stdio: 'ignore', windowsHide: true },
              )
            : spawnAdb(['shell', `screenrecord --time-limit ${this.seg} --size 720x1600 ${file}`], this.o.udid);
        this.child.on('close', () => done());
        this.child.on('error', () => done());
      });
      this.child = undefined;
      this.current = undefined;
      // A segment that ended within 1 s is an error (no device / unsupported); back off instead of spinning.
      if (Date.now() - startedAt < 1_000) {
        await sleep(2_000);
        continue;
      }
      this.ring.push(file);
      while (this.ring.length > this.keep) this.ring.shift();
    }
  }

  /** Stop the running segment gracefully so its container is finalised. */
  private async cutCurrent(): Promise<void> {
    if (!this.child) return;
    const closed = new Promise<void>((r) => this.child?.once('close', () => r()));
    if (this.engine === 'screenrecord') await adb(['shell', 'pkill -INT screenrecord'], this.o.udid).catch(() => {});
    else this.child.kill('SIGINT');
    await Promise.race([closed, sleep(5_000)]);
    if (this.child) this.child.kill();
  }

  /** Copy the newest segments (including the cut current one) into `dir`. Returns copied file names. */
  async snapshot(dir: string): Promise<string[]> {
    this.paused = true;
    await this.cutCurrent();
    await sleep(500);
    await mkdir(dir, { recursive: true });
    const files = [...this.ring].slice(-this.keep);
    const out: string[] = [];
    for (const [i, f] of files.entries()) {
      const name = `video-${i + 1}-of-${files.length}${this.engine === 'scrcpy' ? '.mkv' : '.mp4'}`;
      const dest = join(dir, name);
      const ok =
        this.engine === 'scrcpy'
          ? await copyFile(f, dest).then(() => true, () => false)
          : await adb(['pull', f, dest], this.o.udid, 60_000).then(() => true, () => false);
      if (ok) out.push(name);
    }
    this.paused = false;
    return out;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.cutCurrent();
    await this.loop?.catch(() => {});
    if (this.engine === 'screenrecord') {
      await adb(['shell', 'rm -f /sdcard/autotest_rec_*.mp4'], this.o.udid).catch(() => {});
    } else {
      await rm(this.o.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  describe(): string {
    return `${this.engine} ring ${this.keep}×${this.seg}s${this.engine === 'scrcpy' ? ` (${basename(this.scrcpy!)})` : ''}`;
  }
}
