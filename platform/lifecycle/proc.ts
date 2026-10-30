// Process identity (W2-3 §11 "pid reuse"): a process is "the same" only if its pid AND its start time match
// what the lease recorded. Windows: PowerShell Get-Process; elsewhere: ps -o lstart.
import { execFileSync, spawn } from 'node:child_process';

export interface ProcId {
  pid: number;
  /** Process start time, epoch ms (rounded to the second); undefined = unreadable. */
  startedAt?: number;
}

export interface ProcProbe {
  /** Start time of a live pid (epoch ms), or undefined when no such process. */
  startTime(pid: number): number | undefined;
  kill(pid: number): void;
}

function startTimeOs(pid: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() }`], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
      return out ? Math.floor(Number(out) / 1000) * 1000 : undefined;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim();
    return out ? Math.floor(Date.parse(out) / 1000) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function killTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
}

export const osProbe: ProcProbe = { startTime: startTimeOs, kill: killTree };

/** This process (task processes record themselves in the lease). */
export function selfId(probe: ProcProbe = osProbe): ProcId {
  return { pid: process.pid, startedAt: probe.startTime(process.pid) };
}

/** Pure given the probe: is the recorded process still the one running under that pid? Start times within
 *  2 s count as equal (clock granularity of the two readers). */
export function alive(p: ProcId | undefined, probe: ProcProbe = osProbe): boolean {
  if (!p?.pid) return false;
  const now = probe.startTime(p.pid);
  if (now === undefined) return false;
  return p.startedAt === undefined || Math.abs(now - p.startedAt) <= 2000;
}
