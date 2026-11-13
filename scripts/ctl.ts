// Start / stop the platform service (platform/server.ts) in the background, from one command or one key.
//   pnpm start | stop | restart | status | logs [-f]        (or up.cmd / down.cmd in this folder)
//   tsx scripts/ctl.ts toggle [--open] [--notify]          running → stop, else start (the hotkey's command)
//   tsx scripts/ctl.ts shortcut [--key CTRL+ALT+SHIFT+P] [--remove]   Windows: Start-menu shortcut + global hotkey
// The platform is found by who listens on PLATFORM_PORT (default 3210) and confirmed by its /api/v1 envelope,
// so a stale platform.pid never kills an unrelated process. Stopping ends the session (platform/session.ts,
// user 2026-11-13): running task processes are stopped and every run, report and task record is deleted —
// only what was saved with 「另存为」 (saved/) survives. Every start is a new platform.
import 'dotenv/config';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, watchFile, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endSession } from '../platform/session';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const PORT = Number(process.env.PLATFORM_PORT ?? 3210);
const URL_ = `http://localhost:${PORT}`;
const STATE = process.env.AUTOTEST_STATE_DIR ?? join('platform', 'state'); // relative to ROOT (cwd)
const LOG = join(STATE, 'logs', 'platform.log');
const WIN = process.platform === 'win32';
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 15_000;

// ── output ────────────────────────────────────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32), red = paint(31), yellow = paint(33), dim = paint(2), bold = paint(1);
const ok = (s: string) => console.log(`${green('●')} ${s}`);
const off = (s: string) => console.log(`${dim('○')} ${s}`);
const bad = (s: string) => console.error(`${red('✗')} ${s}`);
const info = (s: string) => console.log(`  ${dim(s)}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// ── probes ────────────────────────────────────────────────────────────────────────────────────────────
type Probe = 'platform' | 'other' | 'down';

/** Who answers on the port: our platform (an /api/v1 envelope), something else, or nobody. */
async function probe(): Promise<Probe> {
  try {
    const res = await fetch(`${URL_}/api/v1/reviewer`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json().catch(() => undefined)) as { code?: unknown; exit?: unknown } | undefined;
    return body && typeof body.code === 'string' && typeof body.exit === 'number' ? 'platform' : 'other';
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code;
    return code === 'ECONNREFUSED' || code === 'ECONNRESET' ? 'down' : 'other';
  }
}

/** The pid listening on the port (netstat on Windows, lsof elsewhere); undefined when nobody / unknown. */
function portOwner(): number | undefined {
  try {
    if (WIN) {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
      // "TCP  0.0.0.0:3210  0.0.0.0:0  LISTENING  22820" — the state word is localized, a :0 remote end is not.
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*TCP\s+\S+:(\d+)\s+\S+:0\s+\S+\s+(\d+)\s*$/.exec(line);
        if (m && Number(m[1]) === PORT) return Number(m[2]);
      }
      return undefined;
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim();
    return out ? Number(out.split('\n')[0]) : undefined;
  } catch {
    return undefined;
  }
}

function pidFile(): number | undefined {
  try {
    const pid = Number(readFileSync(join(STATE, 'platform.pid'), 'utf8').trim());
    return pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Status {
  state: Probe;
  pid?: number;
}

async function status(): Promise<Status> {
  const state = await probe();
  if (state === 'down') return { state };
  return { state, pid: portOwner() ?? (state === 'platform' ? pidFile() : undefined) };
}

/** Running / queued tasks, for status and the stop note. */
async function activeTasks(): Promise<number | undefined> {
  try {
    const res = await fetch(`${URL_}/api/v1/tasks`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { data?: { finishedAt?: string }[] };
    return body.data?.filter((t) => !t.finishedAt).length;
  } catch {
    return undefined;
  }
}

// ── launch ────────────────────────────────────────────────────────────────────────────────────────────
function launch(): void {
  mkdirSync(dirname(LOG), { recursive: true });
  const fd = openSync(LOG, 'a');
  writeSync(fd, `\n──── ${new Date().toISOString()} start (port ${PORT}) ────\n`);
  closeSync(fd);
  // node --import tsx: one process, the pid in platform.pid is the one serving the port.
  const node = ['--import', 'tsx', 'platform/server.ts'];
  if (WIN) {
    // pnpm runs scripts inside a Windows job that is killed when pnpm exits, detached children included.
    // Win32_Process.Create (WMI) starts the platform outside that job — same reason as the task processes
    // (platform/lifecycle/supervisor.ts launchOutside). Only PLATFORM_PORT / AUTOTEST_* are passed on; the
    // platform reads .env itself. Paths in the command line are relative to CurrentDirectory; the directory
    // itself and the node binary must be absolute (WMI starts in system32, with the registry PATH).
    const vars = Object.entries(process.env)
      .filter(([k, v]) => /^(AUTOTEST_|PLATFORM_PORT$)/.test(k) && v !== undefined && !/["&|<>^%\r\n]/.test(v))
      .map(([k, v]) => `set "${k}=${v}"&& `)
      .join('');
    const line = `cmd.exe /d /s /c "${vars}"${process.execPath}" ${node.join(' ')} >> "${LOG}" 2>&1"`;
    const q = (s: string) => s.replace(/'/g, "''");
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(line)}'; CurrentDirectory = '${q(ROOT)}' }; "$($r.ReturnValue)"`;
    const rv = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
    if (rv !== '0') throw new Error(`Win32_Process.Create returned ${rv}`);
    return;
  }
  const out = openSync(LOG, 'a');
  spawn(process.execPath, node, { detached: true, stdio: ['ignore', out, out] }).unref();
  closeSync(out);
}

function logTail(lines = 15): string {
  try {
    const text = readFileSync(LOG, 'utf8');
    const from = text.lastIndexOf('──── ');
    return (from >= 0 ? text.slice(from) : text).trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log yet)';
  }
}

async function waitFor(want: (s: Probe) => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < timeoutMs; i++) {
    if (want(await probe())) {
      if (tty) process.stdout.write('\r\x1b[K');
      return true;
    }
    if (tty) process.stdout.write(`\r${yellow(frames[i % frames.length])} ${label} ${dim(`${Math.round((Date.now() - t0) / 1000)}s`)}`);
    await sleep(400);
  }
  if (tty) process.stdout.write('\r\x1b[K');
  return false;
}

function openBrowser(): void {
  const [cmd, argv] = WIN ? ['rundll32', ['url.dll,FileProtocolHandler', URL_]] : process.platform === 'darwin' ? ['open', [URL_]] : ['xdg-open', [URL_]];
  try {
    spawn(cmd, argv as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* no browser: the URL is printed */
  }
}

function toast(title: string, body: string): void {
  if (!flag('--notify') || !WIN) return;
  const esc = (s: string) => s.replace(/'/g, "''").replace(/[<>&]/g, ' ');
  const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $t = $x.GetElementsByTagName('text'); $t.Item(0).AppendChild($x.CreateTextNode('${esc(title)}')) > $null; $t.Item(1).AppendChild($x.CreateTextNode('${esc(body)}')) > $null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('autotest').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
  } catch {
    /* no toast */
  }
}

// ── commands ──────────────────────────────────────────────────────────────────────────────────────────
async function start(): Promise<number> {
  const s = await status();
  if (s.state === 'platform') {
    ok(`平台已在运行  ${bold(URL_)}  ${dim(`pid ${s.pid ?? '?'}`)}`);
    if (flag('--open')) openBrowser();
    return 0;
  }
  if (s.state === 'other') {
    bad(`端口 ${PORT} 被其他程序占用${s.pid ? `（pid ${s.pid}）` : ''}，不是本平台`);
    info('换端口：.env 里设 PLATFORM_PORT，或先关掉占用的程序');
    return 1;
  }
  const t0 = Date.now();
  try {
    launch();
  } catch (e) {
    bad(`启动失败：${(e as Error).message.split('\n')[0]}`);
    return 1;
  }
  if (!(await waitFor((p) => p === 'platform', START_TIMEOUT_MS, '平台启动中'))) {
    bad(`${START_TIMEOUT_MS / 1000}s 内平台没有响应 ${URL_}`);
    console.error(dim(logTail()));
    info(`完整日志：${LOG}`);
    toast('multi-test-agent', '平台启动失败，见 platform.log');
    return 1;
  }
  const pid = portOwner() ?? pidFile();
  ok(`平台已启动  ${bold(URL_)}  ${dim(`pid ${pid ?? '?'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)}`);
  info(`日志 ${LOG}`);
  toast('multi-test-agent', `平台已启动：${URL_}`);
  if (flag('--open')) openBrowser();
  return 0;
}

async function stop(): Promise<number> {
  const s = await status();
  if (s.state === 'down') {
    off('平台未在运行');
    return clean();
  }
  if (s.state === 'other') {
    bad(`端口 ${PORT} 上不是本平台${s.pid ? `（pid ${s.pid}）` : ''}，不去动它`);
    return 1;
  }
  if (!s.pid || !alive(s.pid)) {
    bad('平台在响应，但找不到它的进程号');
    return 1;
  }
  try {
    process.kill(s.pid, 'SIGTERM'); // Windows: TerminateProcess (shutdown only clears timers, nothing to flush)
  } catch (e) {
    bad(`结束 pid ${s.pid} 失败：${(e as Error).message}`);
    return 1;
  }
  if (!(await waitFor((p) => p === 'down', STOP_TIMEOUT_MS, '平台停止中'))) {
    if (!WIN) {
      try {
        process.kill(s.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    if (!(await waitFor((p) => p === 'down', 5000, '强制结束'))) {
      bad(`pid ${s.pid} 已结束，但端口 ${PORT} 仍有响应`);
      return 1;
    }
  }
  off(`平台已停止  ${dim(`pid ${s.pid}`)}`);
  toast('multi-test-agent', '平台已停止');
  return clean();
}

/** End the session: stop leftover task processes, delete this session's runs and records (saved/ stays). */
async function clean(): Promise<number> {
  const r = await endSession();
  if (r.stopped.length) info(`已停止 ${r.stopped.length} 个运行中的任务`);
  info(`已删除本次的运行、报告和任务记录（${r.removed} 项）；另存为的在 saved/，不删`);
  if (r.failed.length) {
    bad(`${r.failed.length} 项删不掉（可能被占用）：${r.failed.slice(0, 3).join('，')}`);
    return 1;
  }
  return 0;
}

async function showStatus(): Promise<number> {
  const s = await status();
  if (s.state === 'platform') {
    const active = await activeTasks();
    ok(`运行中  ${bold(URL_)}  ${dim(`pid ${s.pid ?? '?'}${active !== undefined ? ` · 进行中任务 ${active}` : ''}`)}`);
    info(`日志 ${LOG}`);
    return 0;
  }
  if (s.state === 'other') {
    bad(`端口 ${PORT} 被其他程序占用${s.pid ? `（pid ${s.pid}）` : ''}`);
    return 1;
  }
  off('已停止');
  return 0;
}

function logs(): number {
  if (!existsSync(LOG)) {
    off(`还没有日志：${LOG}`);
    return 0;
  }
  console.log(logTail(Number(option('-n') ?? 40)));
  if (!flag('-f')) return 0;
  let pos = statSync(LOG).size;
  watchFile(LOG, { interval: 500 }, (cur) => {
    if (cur.size < pos) pos = 0;
    if (cur.size === pos) return;
    const fd = openSync(LOG, 'r');
    const buf = Buffer.alloc(cur.size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    pos = cur.size;
    process.stdout.write(buf);
  });
  return -1; // keep running until Ctrl+C
}

/** Windows: a Start-menu shortcut whose hotkey toggles the platform (Start-menu / Desktop shortcuts get
 *  system-wide hotkeys). Runs minimized; feedback = the browser opening on start, a toast on stop. */
function shortcut(): number {
  if (!WIN) {
    bad('快捷键只支持 Windows；其他系统请把 `pnpm --dir <本目录> exec tsx scripts/ctl.ts toggle --open` 绑到系统快捷键');
    return 1;
  }
  const dir = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const lnk = join(dir, 'multi-test-agent 平台启停.lnk');
  if (flag('--remove')) {
    rmSync(lnk, { force: true });
    off(`已删除快捷方式 ${lnk}`);
    return 0;
  }
  const key = (option('--key') ?? 'CTRL+ALT+SHIFT+P').toUpperCase();
  const q = (s: string) => s.replace(/'/g, "''");
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${q(lnk)}')`,
    `$s.TargetPath = '${q(process.execPath)}'`,
    `$s.Arguments = '--import tsx scripts\\ctl.ts toggle --open --notify'`,
    `$s.WorkingDirectory = '${q(ROOT)}'`,
    `$s.WindowStyle = 7`,
    `$s.Hotkey = '${q(key)}'`,
    `$s.IconLocation = '%SystemRoot%\\System32\\imageres.dll,-1023'`,
    `$s.Description = 'multi-test-agent: start / stop the platform service (${URL_})'`,
    `$s.Save()`,
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe', windowsHide: true, timeout: 30_000 });
  } catch (e) {
    bad(`创建快捷方式失败：${(e as Error).message.split('\n')[0]}`);
    return 1;
  }
  ok(`快捷键 ${bold(key.replace(/\+/g, ' + '))} → 平台启停（启动时打开控制台，停止时弹通知）`);
  info(`快捷方式 ${lnk}`);
  info('也可在开始菜单搜索「multi-test-agent」点开；删除：pnpm ctl shortcut --remove');
  return 0;
}

const HELP = `用法: pnpm <start|stop|restart|status|logs>   或   tsx scripts/ctl.ts <命令> [选项]

  start [--open]        后台启动平台（已在运行则直接返回）；--open 打开 Web 控制台
  stop                  停止平台，停掉运行中的任务，删除本次全部运行和报告（另存为的保留在 saved/）
  restart [--open]      停止后再启动
  status                运行状态
  logs [-f] [-n 40]     平台日志；-f 持续输出
  toggle [--open]       运行中 → 停止，否则启动
  shortcut [--key K]    Windows：创建开始菜单快捷方式 + 全局快捷键（默认 Ctrl+Alt+Shift+P）；--remove 删除

  本目录双击/输入：up.cmd（启动并打开控制台） · down.cmd（停止）
  端口：PLATFORM_PORT（默认 3210，可写在 .env）`;

async function main(): Promise<number> {
  switch (args[0]) {
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'restart': {
      const rc = await stop();
      return rc === 0 ? start() : rc;
    }
    case 'status':
      return showStatus();
    case 'logs':
      return logs();
    case 'toggle':
      return (await probe()) === 'platform' ? stop() : start();
    case 'shortcut':
      return shortcut();
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return 0;
    default:
      bad(`未知命令：${args[0]}`);
      console.log(HELP);
      return 40;
  }
}

main().then(
  (rc) => {
    if (rc >= 0) process.exit(rc);
  },
  (e) => {
    bad((e as Error).stack ?? String(e));
    process.exit(1);
  },
);
