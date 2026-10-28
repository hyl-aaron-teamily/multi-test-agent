// Preflight (W2-2 §4.2, N2): before anything is launched, check the phone is fit to run on. A failed check
// ends the run as 环境不合格 — nothing is tapped in the app, no product conclusion, not a tool failure.
// Allowed setting changes (E3): wake the screen / swipe away a keyguard without a PIN, keep the screen on
// while charging over USB, keep HyperOS 「文本识别」(Taplus) off for the app under test, close a known
// system float. Every change is recorded (manifest). The lock PIN is never touched.
import { existsSync } from 'node:fs';
import { adb } from '../core/adb';
import { sleep } from '../drivers/types';
import type { Surface } from '../platform/schema/test-plan';
import type { EnvSnapshot } from './failure';

export interface PreflightItem {
  id: string;
  ok: boolean;
  detail: string;
}

export interface DeviceInfo {
  udid: string;
  model?: string;
  android?: string;
  hyperos?: string;
  app?: { package: string; versionName?: string; versionCode?: string };
  ime?: string;
  network?: string;
  battery?: number;
  charging?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  ms: number;
  items: PreflightItem[];
  /** Settings / state changed by the preflight (E3), in order. */
  changes: string[];
  /** First failed item (the 环境不合格 reason). */
  reason?: string;
  device?: DeviceInfo;
}

const MIN_BATTERY = 15;

/** Pure: parse the facts the preflight needs from one batched shell read. */
export function parseDeviceState(out: string): {
  wakefulness?: string;
  keyguard?: boolean;
  focus?: string;
  battery?: number;
  charging?: boolean;
  network?: string;
  ime?: string;
  keyboard?: boolean;
  stayOn?: number;
  taplus?: string;
} {
  const get = (re: RegExp) => out.match(re)?.[1]?.trim();
  const level = get(/^\s*level: (\d+)/m);
  const powered = [...out.matchAll(/^\s*(AC|USB|Wireless|Dock) powered: (true|false)/gm)].some((m) => m[2] === 'true');
  // `dumpsys connectivity`: "Active default network: <id>" and per network "NetworkAgentInfo{network{<id>} … ni{WIFI …".
  const def = out.match(/Active default network: (\S+)/)?.[1];
  const transport = def ? out.split(/\r?\n/).find((l) => l.includes(`NetworkAgentInfo{network{${def}}`))?.match(/ni\{(\w+)/)?.[1] : undefined;
  return {
    wakefulness: get(/mWakefulness=(\w+)/),
    keyguard: /isKeyguardShowing=true|mDreamingLockscreen=true|mShowingLockscreen=true/.test(out) ? true : /isKeyguardShowing=false/.test(out) ? false : undefined,
    focus: get(/mCurrentFocus=(.*)/),
    battery: level ? Number(level) : undefined,
    charging: /powered: (true|false)/.test(out) ? powered : undefined,
    network: def === undefined ? undefined : def === 'none' || def === 'null' ? 'none' : (transport ?? 'unknown').toLowerCase(),
    ime: get(/^ime=(.*)$/m),
    keyboard: /mInputShown=true/.test(out) ? true : /mInputShown=false/.test(out) ? false : undefined,
    stayOn: get(/^stayon=(\d+)/m) ? Number(get(/^stayon=(\d+)/m)) : undefined,
    taplus: get(/^taplus=(.*)$/m),
  };
}

const STATE_CMD = [
  "dumpsys power | grep -m1 'mWakefulness='",
  "dumpsys window | grep -E -m3 'mCurrentFocus=|isKeyguardShowing|mDreamingLockscreen'",
  "dumpsys battery | grep -E '^ *(level|AC powered|USB powered|Wireless powered|Dock powered):'",
  "dumpsys connectivity | grep -E 'Active default network|NetworkAgentInfo.network' | cut -c1-120",
  "dumpsys input_method | grep -m1 mInputShown",
  // Quoted: unquoted, the shell brace-expands the JSON value.
  'echo "ime=$(settings get secure default_input_method)"',
  'echo "stayon=$(settings get global stay_on_while_plugged_in)"',
  'echo "taplus=$(settings get global taplus_blacklist)"',
].join('; ');

/** One batched read of the device state (≈ 1 s). */
export async function readDeviceState(udid: string): Promise<ReturnType<typeof parseDeviceState>> {
  return parseDeviceState(await adb(['shell', STATE_CMD], udid, 15_000).catch(() => ''));
}

/** Device state at the moment a run failed (failure classification: env or tool). */
export async function envSnapshot(udid: string, pkg: string): Promise<EnvSnapshot> {
  const online = (await adb(['get-state'], udid, 5000).catch(() => '')).trim() === 'device';
  if (!online) return { online, pkg };
  const s = await readDeviceState(udid);
  return { online, pkg, focus: s.focus, wakefulness: s.wakefulness, keyguard: s.keyguard };
}

/** Pure: the Taplus blacklist JSON with `pkg` added (undefined = already there / unreadable). */
export function taplusWith(raw: string | undefined, pkg: string): string | undefined {
  try {
    const j = JSON.parse(raw && raw !== 'null' ? raw : '{"taplus_blacklist":[]}') as { taplus_blacklist?: string[] };
    const list = j.taplus_blacklist ?? [];
    if (list.includes(pkg)) return undefined;
    return JSON.stringify({ ...j, taplus_blacklist: [...list, pkg] });
  } catch {
    return undefined;
  }
}

const KNOWN_FLOAT = /Taplus|ContentCatcher|contentextension/i;

/** Android preflight (android-app / android-web): ≤ 10 s. `pkg` = app under test (the browser for android-web). */
export async function preflightAndroid(udid: string, pkg: string, surface: Surface): Promise<PreflightResult> {
  const t0 = Date.now();
  const items: PreflightItem[] = [];
  const changes: string[] = [];
  const done = (device?: DeviceInfo): PreflightResult => {
    const bad = items.find((i) => !i.ok);
    return { ok: !bad, ms: Date.now() - t0, items, changes, reason: bad ? `${bad.id}: ${bad.detail}` : undefined, device };
  };
  const sh = (cmd: string, t = 10_000) => adb(['shell', cmd], udid, t);
  const state = (await adb(['get-state'], udid, 5000).catch((e) => `error ${(e as Error).message.split('\n')[0]}`)).trim();
  items.push({ id: 'online', ok: state === 'device', detail: `adb get-state: ${state || '(none)'}` });
  if (state !== 'device') return done({ udid });

  let s = await readDeviceState(udid);
  // Screen on and unlocked: wake, then one swipe up (a keyguard without a PIN goes away); never a PIN.
  if (s.wakefulness && !/awake/i.test(s.wakefulness)) {
    await sh('input keyevent 224');
    changes.push(`唤醒屏幕（KEYCODE_WAKEUP，原 ${s.wakefulness}）`);
    await sleep(700);
    s = await readDeviceState(udid);
  }
  if (s.keyguard || /NotificationShade/.test(s.focus ?? '')) {
    await sh('input swipe 540 1900 540 500 250');
    changes.push('上滑解除无密码锁屏');
    await sleep(900);
    s = await readDeviceState(udid);
  }
  const locked = !!s.keyguard || /NotificationShade|Keyguard/i.test(s.focus ?? '');
  items.push({ id: 'screen', ok: /awake/i.test(s.wakefulness ?? '') && !locked, detail: `wakefulness ${s.wakefulness ?? '?'}, keyguard ${s.keyguard ?? '?'}, focus ${(s.focus ?? '?').slice(0, 90)}${locked ? ' — 锁屏未解除（可能有密码），请人工解锁' : ''}` });

  // Keep the screen on while charging over USB (bit 2 of stay_on_while_plugged_in).
  if (s.stayOn !== undefined && !(s.stayOn & 2)) {
    await sh('svc power stayon usb');
    changes.push(`充电（USB）时屏幕常亮：stay_on_while_plugged_in ${s.stayOn} → 2`);
  }
  // HyperOS 「文本识别」(Taplus) grabs long-presses: keep the app under test on its per-app blacklist.
  const tap = taplusWith(s.taplus, pkg);
  if (tap) {
    await sh(`settings put global taplus_blacklist '${tap}'`);
    changes.push(`HyperOS 文本识别（Taplus）对 ${pkg} 关闭：加入 global taplus_blacklist`);
  }
  // A known system float holding the focus: Back goes to the float only.
  if (KNOWN_FLOAT.test(s.focus ?? '')) {
    await sh('input keyevent 4');
    changes.push(`关闭系统浮层（${(s.focus ?? '').slice(0, 60)}）`);
    await sleep(500);
    s = await readDeviceState(udid);
  }
  items.push({ id: 'overlay', ok: !KNOWN_FLOAT.test(s.focus ?? ''), detail: `focus ${(s.focus ?? '?').slice(0, 90)}` });
  items.push({ id: 'battery', ok: s.battery === undefined || s.battery >= MIN_BATTERY, detail: `${s.battery ?? '?'}%${s.charging ? '（充电中）' : ''}${s.battery !== undefined && s.battery < MIN_BATTERY ? ` < ${MIN_BATTERY}%` : ''}` });
  items.push({ id: 'network', ok: s.network !== 'none', detail: `default network: ${s.network ?? 'unknown'}` });
  if (s.keyboard) {
    await sh('input keyevent 111'); // Escape closes the keyboard without leaving a screen
    changes.push('收起软键盘（Escape）');
  }

  const info = await sh(`getprop ro.product.model; getprop ro.build.version.release; getprop ro.mi.os.version.name; getprop ro.mi.os.version.incremental; dumpsys package ${pkg} | grep -E -m2 'versionName=|versionCode='`).catch(() => '');
  const lines = info.split(/\r?\n/).map((l) => l.trim());
  const versionName = info.match(/versionName=(\S+)/)?.[1];
  const versionCode = info.match(/versionCode=(\d+)/)?.[1];
  items.push({ id: 'app', ok: !!versionName, detail: versionName ? `${pkg} ${versionName} (${versionCode ?? '?'})` : `${pkg} not installed / version unreadable` });
  const device: DeviceInfo = { udid, model: lines[0] || undefined, android: lines[1] || undefined, hyperos: [lines[2], lines[3]].filter(Boolean).join(' ') || undefined, app: { package: pkg, versionName, versionCode }, ime: s.ime, network: s.network, battery: s.battery, charging: s.charging };
  return done(device);
}

/** Web surfaces (W2-2 §4.2: minimal): the browser binary is there and the account's session is usable. */
export async function preflightWeb(o: { browserPath?: string; sessionOk: boolean; sessionDetail: string }): Promise<PreflightResult> {
  const t0 = Date.now();
  const items: PreflightItem[] = [
    { id: 'browser', ok: !o.browserPath || existsSync(o.browserPath), detail: o.browserPath ? `chromium ${existsSync(o.browserPath) ? 'present' : 'missing'}: ${o.browserPath}` : 'chromium path not checked' },
    { id: 'login', ok: o.sessionOk, detail: o.sessionDetail },
  ];
  const bad = items.find((i) => !i.ok);
  return { ok: !bad, ms: Date.now() - t0, items, changes: [], reason: bad ? `${bad.id}: ${bad.detail}` : undefined };
}
