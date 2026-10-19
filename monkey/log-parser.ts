// monkey.log parsing + correlation with logcat crash scenes.
// Monkey -vvv lines used:
//   "    // Sending event #1200"                       → injected-event counter
//   "    //[calendar_time:2026-10-19 17:55:01.123  system_uptime:123456]"
//   "// CRASH: com.pkg (pid 1234)" + "// Short Msg: ..." + "// Long Msg: ..."
//   "// NOT RESPONDING: com.pkg (pid 1234)" / "ANR in com.pkg"
//   "Events injected: 3000", "// Monkey finished", "** Monkey aborted due to error."
// ref: Android Monkey docs + observed device output (no parser in ref/)
import { readFile } from 'node:fs/promises';
import type { CrashEvent } from '../core/logcat-monitor';

export interface MonkeySignal {
  kind: 'CRASH' | 'ANR' | 'NATIVE_CRASH';
  line: number;
  text: string;
  packageName: string | null;
  shortMsg: string | null;
  longMsg: string | null;
  /** Approx. index of the last injected event before the signal (max of "Sending event #N" and line count). */
  eventCount: number | null;
  /** Last calendar_time / system_uptime seen before the signal. */
  calendarTime: string | null;
  systemUptime: number | null;
}

export interface ParsedMonkeyLog {
  signals: MonkeySignal[];
  eventsInjected: number | null;
  finished: boolean;
  aborted: boolean;
}

/** Pure parser over monkey.log text. */
export function parseMonkeyLog(text: string): ParsedMonkeyLog {
  const lines = text.split(/\r?\n/);
  const signals: MonkeySignal[] = [];
  let lastEvent: number | null = null;
  let lastCal: string | null = null;
  let lastUptime: number | null = null;
  let eventsInjected: number | null = null;
  // "Sending event #N" only every 100 events; also count individual ":Sending"/":Switch" lines.
  let sent = 0;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (/^:(Sending|Switch)/.test(line)) sent++;
    const ev = line.match(/Sending event #(\d+)/);
    if (ev) lastEvent = Number(ev[1]);
    const t = line.match(/calendar_time:([\d-]+ [\d:.]+)\s+system_uptime:(\d+)/);
    if (t) {
      lastCal = t[1];
      lastUptime = Number(t[2]);
    }
    const inj = line.match(/Events injected:\s*(\d+)/);
    if (inj) eventsInjected = Number(inj[1]);

    let kind: MonkeySignal['kind'] | undefined;
    let pkg: string | null = null;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\/\/ CRASH: (\S+)/))) {
      kind = 'CRASH';
      pkg = m[1];
    } else if ((m = line.match(/NOT RESPONDING: (\S+)/))) {
      kind = 'ANR';
      pkg = m[1];
    } else if ((m = line.match(/^\/\/ NATIVE CRASH: (\S+)|^\*\* New native crash detected/))) {
      kind = 'NATIVE_CRASH';
      pkg = m[1] ?? null;
    }
    if (!kind) return;
    const next = lines.slice(i + 1, i + 8).map((l) => l.trim());
    const pick = (p: string) => next.find((l) => l.startsWith(p))?.slice(p.length).trim() ?? null;
    signals.push({
      kind,
      line: i + 1,
      text: line,
      packageName: pkg,
      shortMsg: pick('// Short Msg:'),
      longMsg: pick('// Long Msg:'),
      eventCount: lastEvent === null && sent === 0 ? null : Math.max(lastEvent ?? 0, sent),
      calendarTime: lastCal,
      systemUptime: lastUptime,
    });
  });

  return {
    signals,
    eventsInjected,
    finished: /\/\/ Monkey finished/.test(text),
    aborted: /\*\* Monkey aborted/.test(text),
  };
}

export async function parseMonkeyLogFile(path: string): Promise<ParsedMonkeyLog> {
  return parseMonkeyLog(await readFile(path, 'utf8').catch(() => ''));
}

export interface CorrelatedCrash {
  logcat: Pick<CrashEvent, 'dir' | 'timestamp' | 'keywords' | 'firstLine' | 'matchesPackage'> | null;
  monkey: MonkeySignal | null;
  note: string;
}

/** Device local "YYYY-MM-DD HH:mm:ss.SSS" → epoch ms (host and device assumed same timezone). */
function calendarMs(s: string | null): number | null {
  if (!s) return null;
  const ms = new Date(s.replace(' ', 'T')).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Pair logcat crash scenes with monkey.log signals: same kind (ANR ↔ ANR in) and the monkey
 * timestamp within ±windowMs of the logcat capture. logcat is the source of truth.
 */
export function correlate(
  logcatCrashes: CorrelatedCrash['logcat'][],
  parsed: ParsedMonkeyLog,
  windowMs = 15_000,
): CorrelatedCrash[] {
  const unused = new Set(parsed.signals);
  const out: CorrelatedCrash[] = [];
  for (const lc of logcatCrashes) {
    if (!lc) continue;
    const isAnr = lc.keywords.includes('ANR in') && !lc.keywords.includes('FATAL EXCEPTION');
    const at = new Date(lc.timestamp).getTime();
    let best: MonkeySignal | null = null;
    let bestGap = Infinity;
    for (const s of unused) {
      if ((s.kind === 'ANR') !== isAnr) continue;
      const ms = calendarMs(s.calendarTime);
      const gap = ms === null ? windowMs : Math.abs(ms - at);
      if (gap <= windowMs && gap < bestGap) {
        best = s;
        bestGap = gap;
      }
    }
    if (best) unused.delete(best);
    out.push({
      logcat: lc,
      monkey: best,
      note: best ? `monkey.log line ${best.line} 交叉验证 (event #${best.eventCount ?? '?'})` : 'Monkey 日志未标记，logcat 捕获',
    });
  }
  for (const s of unused) out.push({ logcat: null, monkey: s, note: 'Monkey 日志标记，但 logcat 未捕获（待观察）' });
  return out;
}
