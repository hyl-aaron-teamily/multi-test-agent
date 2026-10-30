// Host side of the on-device read-only accessibility service (W2-4 §4.1 backend B; source in
// android/a11y-service, built to tools/a11y/autotest-a11y.apk). Protocol (HTTP/1.0 on the phone's loopback):
//   GET /ping                → {"ok":true,"name":"autotest-a11y","version":N,"connected":bool}   (no token)
//   GET /dump?token=<t>      → uiautomator-format XML of every window (401 without the token)
// The token reaches the phone by broadcast from the adb shell user only (receiver guarded by
// android.permission.DUMP, which apps cannot hold). The host reaches the port through `adb forward`
// (one per device, reused, removed at exit). Read only: the service performs no gestures and sends nothing out.
// Device-side token + loopback design after Artemis' accessibility helper (ref/artemis, Apache-2.0); our own code.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { adb, resolveAdbPath } from './adb';
import type { TreeBackend } from './tree-backend';

export const A11Y_PKG = 'ai.autotest.a11y';
export const A11Y_SERVICE = `${A11Y_PKG}/${A11Y_PKG}.TreeService`;
export const A11Y_PORT = 18765;
export const A11Y_TOKEN_ACTION = `${A11Y_PKG}.SET_TOKEN`;
export const A11Y_APK = resolve(process.env.AUTOTEST_A11Y_APK ?? 'tools/a11y/autotest-a11y.apk');

const ports = new Map<string, number>();
const tokens = new Map<string, string>();

/** Pure: `adb forward --list` lines that point at our service port → { serial, local }. */
export function parseForwards(out: string): { serial: string; local: string }[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 3 && p[2] === `tcp:${A11Y_PORT}`)
    .map(([serial, local]) => ({ serial, local }));
}

async function forward(udid: string): Promise<number> {
  const known = ports.get(udid);
  if (known) return known;
  const out = (await adb(['forward', 'tcp:0', `tcp:${A11Y_PORT}`], udid, 10_000)).trim();
  const port = Number(out);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`adb forward gave "${out}"`);
  ports.set(udid, port);
  return port;
}

async function get(udid: string, path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const port = await forward(udid);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    // A stale forward (device reconnected) — remove it so the next call makes a new one.
    ports.delete(udid);
    await adb(['forward', '--remove', `tcp:${port}`], udid, 5000).catch(() => '');
    throw e;
  }
}

async function sendToken(udid: string): Promise<string> {
  const t = randomBytes(16).toString('hex');
  const out = await adb(['shell', `am broadcast -a ${A11Y_TOKEN_ACTION} -n ${A11Y_PKG}/.TokenReceiver --es token ${t}`], udid, 10_000);
  if (!/Broadcast completed/.test(out)) throw new Error(`token broadcast failed: ${out.trim().slice(0, 120)}`);
  tokens.set(udid, t);
  return t;
}

export interface A11yHealth {
  installed: boolean;
  enabled: boolean;
  responding: boolean;
  version?: number;
  /** The service reports it is connected to the accessibility framework. */
  connected?: boolean;
  detail: string;
}

/** Pure: is our service in a `enabled_accessibility_services` value? */
export const servicesHave = (v: string) => v.split(':').some((s) => s.trim() === A11Y_SERVICE || s.trim() === `${A11Y_PKG}/.TreeService`);

/** Pure: the settings value with our service added / removed (other services kept, order kept). */
export function servicesWith(v: string | undefined, on: boolean): string {
  const list = (v && v !== 'null' ? v.split(':') : []).map((s) => s.trim()).filter((s) => s && s !== A11Y_SERVICE && s !== `${A11Y_PKG}/.TreeService`);
  return (on ? [...list, A11Y_SERVICE] : list).join(':');
}

export async function a11yHealth(udid: string): Promise<A11yHealth> {
  const installed = /package:/.test(await adb(['shell', `pm path ${A11Y_PKG}`], udid, 10_000).catch(() => ''));
  if (!installed) return { installed, enabled: false, responding: false, detail: `${A11Y_PKG} 未安装` };
  const enabled = servicesHave((await adb(['shell', 'settings get secure enabled_accessibility_services'], udid, 10_000).catch(() => '')).trim());
  if (!enabled) return { installed, enabled, responding: false, detail: '已安装，无障碍服务未启用' };
  try {
    const r = await get(udid, '/ping', 2000);
    const j = JSON.parse(r.body) as { ok?: boolean; version?: number; connected?: boolean };
    const responding = r.status === 200 && !!j.ok;
    return { installed, enabled, responding, version: j.version, connected: j.connected, detail: responding ? `服务正常（v${j.version ?? '?'}${j.connected === false ? '，未连接无障碍框架' : ''}）` : `/ping 返回 ${r.status}` };
  } catch (e) {
    return { installed, enabled, responding: false, detail: `已启用但不响应（${(e as Error).message.slice(0, 80)}；可能被系统回收，诊断建议把它加入电池白名单）` };
  }
}

/** Backend B for core/tree-backend.ts. Throws on any failure (the caller falls back to uiautomator). */
export function a11yBackend(): TreeBackend {
  return {
    name: 'a11y-service',
    async dump(udid, timeoutMs) {
      if (!udid) throw new Error('a11y-service needs a device serial');
      let t = tokens.get(udid) ?? (await sendToken(udid));
      let r = await get(udid, `/dump?token=${t}`, timeoutMs);
      if (r.status === 401) {
        // The service restarted and lost its token.
        t = await sendToken(udid);
        r = await get(udid, `/dump?token=${t}`, timeoutMs);
      }
      if (r.status !== 200) throw new Error(`/dump ${r.status} ${r.body.slice(0, 80)}`);
      return r.body;
    },
  };
}

/** Make the service usable for this process: responding + token accepted. Returns why not, if not. */
export async function activateA11y(udid: string): Promise<{ ok: boolean; reason?: string; health: A11yHealth }> {
  const h = await a11yHealth(udid);
  if (!h.responding) return { ok: false, reason: h.detail, health: h };
  try {
    const xml = await a11yBackend().dump(udid, 5000);
    if (!/<node\b/.test(xml)) return { ok: false, reason: '服务返回空树', health: h };
    return { ok: true, health: h };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 120), health: h };
  }
}

// ---- configuration item `a11y-service` (consented once; applied by env check / recovery, never by preflight)

export async function installA11y(udid: string, apk = A11Y_APK): Promise<void> {
  if (!existsSync(apk)) throw new Error(`没有构建好的 APK：${apk}（sh android/a11y-service/build.sh）`);
  const out = await adb(['install', '-r', apk], udid, 120_000);
  if (!/Success/.test(out)) throw new Error(`安装失败：${out.trim().slice(0, 200)}`);
}

export async function enableA11y(udid: string): Promise<void> {
  const cur = (await adb(['shell', 'settings get secure enabled_accessibility_services'], udid, 10_000)).trim();
  if (servicesHave(cur)) return;
  await adb(['shell', `settings put secure enabled_accessibility_services '${servicesWith(cur, true)}'`], udid, 10_000);
  await adb(['shell', 'settings put secure accessibility_enabled 1'], udid, 10_000);
}

export async function disableA11y(udid: string): Promise<void> {
  const cur = (await adb(['shell', 'settings get secure enabled_accessibility_services'], udid, 10_000)).trim();
  if (!servicesHave(cur)) return;
  const next = servicesWith(cur, false);
  await adb(['shell', next ? `settings put secure enabled_accessibility_services '${next}'` : 'settings delete secure enabled_accessibility_services'], udid, 10_000);
}

export async function uninstallA11y(udid: string): Promise<void> {
  await disableA11y(udid).catch(() => {});
  await adb(['uninstall', A11Y_PKG], udid, 60_000).catch(() => '');
}

/** Our forwards still registered with adb (any device). */
export async function a11yForwards(): Promise<{ serial: string; local: string }[]> {
  return parseForwards(await adb(['forward', '--list'], undefined, 10_000).catch(() => ''));
}

export async function removeForward(serial: string, local: string): Promise<void> {
  await adb(['forward', '--remove', local], serial, 10_000);
}

// Forwards this process made are removed when it exits (sync: the event loop is gone by then).
process.once('exit', () => {
  for (const [udid, port] of ports) {
    try {
      execFileSync(resolveAdbPath(), ['-s', udid, 'forward', '--remove', `tcp:${port}`], { stdio: 'ignore', timeout: 3000, windowsHide: true });
    } catch {
      /* device gone */
    }
  }
});
