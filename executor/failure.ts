// Failure classification (W2-2 §3.3, N3): every run that ends without a verdict is put into exactly one of
// three buckets, counted separately — environment (the phone / network / OS got in the way), tool (our code
// or plan: locate failed, a menu did not open, a send was swallowed) — and product findings are verdicts, not
// failures. One place, rule table first, unit-tested (executor/unit.spec.ts).
import type { Conclusion } from './verdict';

export type FailureKind = 'env' | 'tool';

export interface Failure {
  kind: FailureKind;
  /** Rule that decided it (report). */
  rule: string;
  reason: string;
}

/** What the device looked like when the run failed (preflight.ts#deviceState), if read. */
export interface EnvSnapshot {
  /** `dumpsys window` mCurrentFocus line. */
  focus?: string;
  /** `dumpsys power` mWakefulness (Awake / Asleep / Dozing). */
  wakefulness?: string;
  keyguard?: boolean;
  /** adb get-state. */
  online?: boolean;
  /** The app's package (to tell "another window has the focus"). */
  pkg?: string;
}

const ENV_TEXT: [string, RegExp][] = [
  ['device-offline', /device (offline|not found|unauthorized)|no devices\/emulators|adb: (device|no devices)|closed by remote host/i],
  ['screen-locked', /keyguard|锁屏|熄屏|screen (is )?(off|locked)|NotificationShade/i],
  ['system-overlay', /system (float|overlay)|文本识别|taplus|contentextension/i],
  ['network', /no (usable )?network|network (is )?unreachable|断网|ENETUNREACH|EAI_AGAIN|getaddrinfo|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED)/i],
  ['app-killed', /background death|lowmemorykiller|killed by (the )?system|am_kill/i],
];

/** Pure: environment or tool? Text rules first, then the device snapshot (focus elsewhere, asleep, locked). */
export function classifyFailure(conclusion: Conclusion, error: string, env?: EnvSnapshot): Failure {
  if (conclusion === '环境不合格') return { kind: 'env', rule: 'preflight', reason: error };
  if (conclusion === '计划不可执行') return { kind: 'tool', rule: 'warm-up', reason: error };
  if (conclusion === 'SKILL 失效') return { kind: 'tool', rule: 'skill-stale', reason: error };
  for (const [rule, re] of ENV_TEXT) if (re.test(error)) return { kind: 'env', rule, reason: error };
  if (env) {
    if (env.online === false) return { kind: 'env', rule: 'device-offline', reason: `${error} — device offline` };
    if (env.wakefulness && !/awake/i.test(env.wakefulness)) return { kind: 'env', rule: 'screen-off', reason: `${error} — screen ${env.wakefulness}` };
    if (env.keyguard) return { kind: 'env', rule: 'screen-locked', reason: `${error} — keyguard showing` };
    if (env.focus && /NotificationShade|StatusBar/i.test(env.focus)) return { kind: 'env', rule: 'screen-locked', reason: `${error} — focus ${env.focus}` };
    if (env.focus && env.pkg && !env.focus.includes(env.pkg)) return { kind: 'env', rule: 'focus-elsewhere', reason: `${error} — focus on ${env.focus}` };
  }
  return { kind: 'tool', rule: 'default', reason: error };
}

export const FAILURE_TEXT: Record<FailureKind, string> = { env: '环境', tool: '工具' };
