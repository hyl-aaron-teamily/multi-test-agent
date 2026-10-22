// Android black-box driver: coordinates through ONE resident `adb shell` (no JVM / process start per
// command on the host side), text via yadb (IME-proof, as validated by imui), observation from a single
// logcat stream (-b main -b system -b crash -b events) — no per-step screencap / pidof / dumpsys.
//   crash / ANR     : FATAL EXCEPTION, ANR in, am_crash, am_anr
//   process death   : am_proc_died / "Process <pkg> (pid N) has died"
//   left the app    : wm_set_resumed_activity / am_focused_* naming another package
//   app E/ lines    : of the app's pid, matched against the SKILL table → suspect only
import { AndroidDevice } from '@midscene/android';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { adb, launchApp, resolveAdbPath, screencap, spawnAdb } from '../core/adb';
import { type Anomaly, type Driver, type Point, sleep } from './types';

export interface AndroidDriverOptions {
  udid: string;
  packageName: string;
  /** android-web: the phone's browser (packageName) opened on this URL. Default android-app. */
  surface?: 'android-app' | 'android-web';
  url?: string;
  /** App E/ lines matching this are recorded as suspect signals. */
  appErrorRe?: RegExp;
  /** Every logcat line, host-timestamped (flight recorder). */
  onLog?: (at: number, line: string) => void;
}

const KEYCODES: Record<string, number> = { enter: 66, back: 4, home: 3, backspace: 67, del: 67, escape: 111, tab: 61, up: 19, down: 20, left: 21, right: 22, space: 62 };

/** Pure: classify one logcat line for the anomaly gate. */
export function classifyLogLine(line: string, pkg: string, pid?: number, appErrorRe?: RegExp): Anomaly | undefined {
  const at = Date.now();
  const p = pkg.replace(/\./g, '\\.');
  if (/FATAL EXCEPTION/.test(line) || (/\bam_crash\b/.test(line) && new RegExp(p).test(line))) return { kind: 'crash', at, detail: line.trim() };
  if (new RegExp(`ANR in ${p}`).test(line) || (/\bam_anr\b/.test(line) && new RegExp(p).test(line))) return { kind: 'anr', at, detail: line.trim() };
  if ((/\bam_proc_died\b/.test(line) && new RegExp(`,${p}(,|\\])`).test(line)) || new RegExp(`Process ${p} \\(pid \\d+\\) has died`).test(line)) return { kind: 'app-exit', at, detail: line.trim() };
  const resumed = line.match(/\b(?:wm_set_resumed_activity|am_focused_activity|am_focused_root_task|wm_focused_root_task)\b.*?\b([a-zA-Z][\w.]+)\/[\w.$]+/);
  if (resumed && resumed[1] !== pkg && !/^(com\.android\.systemui|android)$/.test(resumed[1])) return { kind: 'left-app', at, detail: `foreground ${resumed[1]}: ${line.trim()}` };
  if (pid && appErrorRe && new RegExp(`\\b${pid}\\b`).test(line) && /\sE[/\s]/.test(line) && appErrorRe.test(line)) return { kind: 'app-error', at, detail: line.trim(), suspect: true };
  return undefined;
}

export class AndroidDriver implements Driver {
  readonly surface: 'android-app' | 'android-web';
  private shell?: ChildProcessWithoutNullStreams;
  private shellQueue: { marker: string; resolve: () => void }[] = [];
  private seq = 0;
  private logcat?: ChildProcessWithoutNullStreams;
  private anomalies: Anomaly[] = [];
  private device?: AndroidDevice;
  pid?: number;
  /** From wm_set_resumed_activity: is the app in the foreground right now? */
  foreground = true;
  /** The app is away on purpose (Home / killed / another surface in front): leaving it or its process
   *  ending is the plan, not a finding. Cleared by launch() / focus(). Crashes and ANRs still count. */
  away = false;
  private launched = false;

  constructor(readonly o: AndroidDriverOptions) {
    this.surface = o.surface ?? 'android-app';
  }

  /** Resident shell: commands are written to stdin; a marker echo tells us each finished. */
  private ensureShell(): ChildProcessWithoutNullStreams {
    if (this.shell && !this.shell.killed && this.shell.exitCode === null) return this.shell;
    const sh = spawnAdb(['shell'], this.o.udid);
    sh.stdout.setEncoding('utf8');
    let buf = '';
    sh.stdout.on('data', (d: string) => {
      buf += d;
      for (;;) {
        const head = this.shellQueue[0];
        if (!head) break;
        const i = buf.indexOf(head.marker);
        if (i < 0) break;
        buf = buf.slice(i + head.marker.length);
        this.shellQueue.shift();
        head.resolve();
      }
      if (buf.length > 1_000_000) buf = buf.slice(-10_000);
    });
    sh.on('exit', () => {
      for (const q of this.shellQueue.splice(0)) q.resolve();
    });
    this.shell = sh;
    return sh;
  }

  /** Run a device shell command in the resident session and wait for it to finish. */
  async sh(cmd: string, timeoutMs = 10_000): Promise<void> {
    const sh = this.ensureShell();
    const marker = `__at_${++this.seq}__`;
    const done = new Promise<void>((resolve) => this.shellQueue.push({ marker, resolve }));
    sh.stdin.write(`${cmd}; echo ${marker}\n`);
    await Promise.race([done, sleep(timeoutMs).then(() => Promise.reject(new Error(`adb shell timeout: ${cmd.slice(0, 60)}`)))]);
  }

  async launch(): Promise<void> {
    this.startLogcat();
    // Browser: open the URL in it the first time and after its process was killed (what opening a link
    // does); otherwise, like an app, its launcher icon brings back the open tab.
    if (this.o.url && (!this.launched || !(await this.processAlive()))) await this.openUrl();
    else await launchApp(this.o.packageName, this.o.udid);
    this.launched = true;
    this.foreground = true;
    await sleep(2500);
    await this.refreshPid();
    this.away = false;
  }

  /** Browser: load the app address in our tab, as opening a link does. application_id makes the browser
   *  reuse the tab it opened for us; the query makes it a real load even when the address is unchanged. */
  async openUrl(path?: string): Promise<void> {
    if (!this.o.url) throw new Error('openUrl: no url (android-web only)');
    const base = path ? new URL(path, this.o.url).toString() : this.o.url;
    const u = `${base}${base.includes('?') ? '&' : '?'}autotest=${Date.now()}`;
    await this.sh(`am start -a android.intent.action.VIEW -d '${u}' -p ${this.o.packageName} --es com.android.browser.application_id ai.autotest`);
  }

  /** Home key: the app goes to the background and keeps its process. */
  async exitApp(): Promise<void> {
    this.away = true;
    await this.sh('input keyevent 3');
    this.foreground = false;
  }

  /** Kill the app process (as swiping it out of recents does) and confirm it is gone. */
  async killApp(): Promise<void> {
    this.away = true;
    this.foreground = false;
    await this.sh(`am force-stop ${this.o.packageName}`);
    for (let i = 0; i < 10; i++) {
      if ((await this.processAlive(true)) === false) {
        this.pid = undefined;
        return;
      }
      await sleep(300);
    }
    throw new Error(`killApp: ${this.o.packageName} still running after force-stop`);
  }

  /** Native app: no page reload — cold restart (kill, then launch). */
  async reload(): Promise<void> {
    await this.killApp();
    await this.launch();
  }

  /** Bring the app back in front of another surface on the same phone (warm, like tapping its icon). */
  async focus(): Promise<void> {
    if (this.foreground && !this.away) return;
    await launchApp(this.o.packageName, this.o.udid);
    this.foreground = true;
    await sleep(1200);
    this.away = false;
  }

  yieldFocus(): void {
    this.away = true;
  }

  /** Is the app process running? `strict`: an adb failure throws instead of reading as "not running". */
  async processAlive(strict = false): Promise<boolean> {
    try {
      const out = await adb(['shell', 'pidof', this.o.packageName], this.o.udid);
      return /\d/.test(out);
    } catch (e) {
      // pidof exits 1 when there is no such process; adb itself failing is something else.
      if ((e as { code?: number }).code === 1 && !(e as { stderr?: string }).stderr) return false;
      if (strict) throw new Error(`processAlive: adb failed (${(e as Error).message.split(String.fromCharCode(10))[0]})`);
      return false;
    }
  }

  async refreshPid(): Promise<void> {
    const out = await adb(['shell', 'pidof', this.o.packageName], this.o.udid).catch(() => '');
    const pid = Number(out.trim().split(/\s+/)[0]);
    this.pid = Number.isFinite(pid) && pid > 0 ? pid : undefined;
  }

  private startLogcat(): void {
    if (this.logcat) return;
    // -T 1: only lines from now on; the caller clears the buffer at task start if it wants (logcat -c).
    const lc = spawnAdb(['logcat', '-v', 'threadtime', '-b', 'main', '-b', 'system', '-b', 'crash', '-b', 'events', '-T', '1'], this.o.udid);
    this.logcat = lc;
    const rl = createInterface({ input: lc.stdout });
    rl.on('line', (line) => {
      const at = Date.now();
      this.o.onLog?.(at, line);
      if (/\bam_proc_start\b/.test(line) && line.includes(this.o.packageName)) {
        const m = line.match(/\[\d+,(\d+),\d+,/);
        if (m) this.pid = Number(m[1]);
      }
      const res = line.match(/\bwm_set_resumed_activity\b.*?\[\d+,([\w.]+)\//);
      if (res) this.foreground = res[1] === this.o.packageName;
      const a = classifyLogLine(line, this.o.packageName, this.pid, this.o.appErrorRe);
      // Planned exits (Home, kill, another surface in front) are not findings.
      if (this.away && (a?.kind === 'left-app' || a?.kind === 'app-exit')) return;
      // A background process killed by the system (low-memory / cached trim) is not an app failure.
      if (a?.kind === 'app-exit' && !this.foreground) this.anomalies.push({ ...a, at, suspect: true, kind: 'app-error', detail: `background death: ${a.detail}` });
      else if (a) this.anomalies.push({ ...a, at });
    });
  }

  async tap(p: Point): Promise<void> {
    await this.sh(`input tap ${Math.round(p.x)} ${Math.round(p.y)}`);
  }

  async longPress(p: Point, ms = 800): Promise<void> {
    await this.sh(`input swipe ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.x)} ${Math.round(p.y)} ${ms}`);
  }

  async type(text: string): Promise<void> {
    if (/^[\x21-\x7e]+$/.test(text) && !/[\\'"`$&|;<>()*?~]/.test(text)) {
      // Plain ASCII: input text in the resident shell (fast). Chinese / symbols → yadb.
      await this.sh(`input text '${text}'`);
      return;
    }
    if (!this.device) {
      const adbPath = resolveAdbPath();
      this.device = new AndroidDevice(this.o.udid, adbPath === 'adb' ? {} : { androidAdbPath: adbPath });
    }
    await this.device.execYadb(text);
  }

  async key(name: string): Promise<void> {
    const code = KEYCODES[name.toLowerCase()] ?? Number(name);
    if (!Number.isFinite(code)) throw new Error(`unknown key ${name}`);
    await this.sh(`input keyevent ${code}`);
  }

  async swipe(from: Point, to: Point, ms = 300): Promise<void> {
    await this.sh(`input swipe ${Math.round(from.x)} ${Math.round(from.y)} ${Math.round(to.x)} ${Math.round(to.y)} ${ms}`);
  }

  async scroll(at: Point, dy: number): Promise<void> {
    await this.swipe(at, { x: at.x, y: at.y - dy }, 250);
  }

  async back(): Promise<void> {
    await this.key('back');
  }

  screenshot(): Promise<Buffer> {
    return screencap(this.o.udid);
  }

  drainAnomalies(): Anomaly[] {
    const a = this.anomalies;
    this.anomalies = [];
    return a;
  }

  async close(): Promise<void> {
    this.shell?.stdin.end();
    this.shell?.kill();
    this.logcat?.kill();
    this.logcat = undefined;
    this.shell = undefined;
  }
}
