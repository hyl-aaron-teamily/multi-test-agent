// Pure-function checks for the Monkey path (no device needed).
import { describe, expect, it } from 'vitest';
import { correlate, parseMonkeyLog } from './log-parser';
import { monkeyArgs, reproduceCommand } from './runner';

const LOG = `:Monkey: seed=12345 count=3000
    //[calendar_time:2026-10-19 17:55:00.000  system_uptime:1000]
    // Sending event #100
    //[calendar_time:2026-10-19 17:55:10.000  system_uptime:11000]
    // Sending event #200
// CRASH: com.example.app (pid 4242)
// Short Msg: java.lang.NullPointerException
// Long Msg: java.lang.NullPointerException: boom
// NOT RESPONDING: com.example.app (pid 4243)
Events injected: 3000
// Monkey finished
`;

describe('monkey helpers', () => {
  it('builds a reproducible command', () => {
    const args = monkeyArgs({ packageName: 'com.example.app', seed: 12345, eventCount: 3000, throttle: 300 });
    expect(reproduceCommand(args, 'abc')).toBe(
      'adb -s abc shell monkey -p com.example.app -s 12345 --throttle 300 --randomize-throttle -vvv --ignore-crashes --ignore-timeouts --monitor-native-crashes 3000',
    );
  });

  it('parses CRASH / NOT RESPONDING with event counter and time', () => {
    const p = parseMonkeyLog(LOG);
    expect(p.eventsInjected).toBe(3000);
    expect(p.finished).toBe(true);
    expect(p.signals.map((s) => s.kind)).toEqual(['CRASH', 'ANR']);
    expect(p.signals[0]).toMatchObject({ packageName: 'com.example.app', shortMsg: 'java.lang.NullPointerException', eventCount: 200, line: 6 });
  });

  it('correlates logcat crashes, logcat wins when monkey is silent', () => {
    const p = parseMonkeyLog(LOG);
    const lc = (ts: string, kw: 'FATAL EXCEPTION' | 'ANR in') => ({ dir: 'd', timestamp: new Date(ts).toISOString(), keywords: [kw], firstLine: '', matchesPackage: true });
    const r = correlate([lc('2026-10-19T17:55:12', 'FATAL EXCEPTION'), lc('2026-10-19T18:30:00', 'FATAL EXCEPTION')], p);
    expect(r[0].monkey?.kind).toBe('CRASH');
    expect(r[1].note).toContain('logcat 捕获');
    expect(r[2].monkey?.kind).toBe('ANR'); // monkey-only leftover
  });
});
