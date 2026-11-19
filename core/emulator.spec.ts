// W3-4 E1: the emulator as a test device — APK reading / patching, AVD config, snapshots, device config (K8),
// forced update, app login steps, suite placeholders, environment items and doctor for emulators.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apkSets, needsInstall, parseManifest, patchExtractNativeLibs } from './apk';
import { parseSnapshots, patchIni } from './emulator';
import { emulatorOf, parsePoolConfig } from '../platform/device-pool';
import { forcedUpdate } from '../engine/app-update';
import { loginStep, submitButton } from '../engine/login/app-login';
import { classifyFailure } from '../engine/failure';
import { parseDeviceState } from '../engine/preflight';
import { androidConfigItems } from '../platform/lifecycle/android-ops';
import { declareEnvs } from '../platform/lifecycle/registry';
import { diagnose, type Facts } from '../platform/doctor';
import { memberFor, parseEnvId } from '../scripts/explore-suite';
import type { UiNode } from './ui-tree';

/** A minimal binary AndroidManifest.xml: <manifest package versionCode versionName><application extractNativeLibs/>. */
function axml(o: { pkg: string; code: number; name: string; extract?: boolean }): Buffer {
  const strings = ['versionCode', 'versionName', 'extractNativeLibs', 'package', 'manifest', 'application', o.pkg, o.name];
  const resIds = [0x0101021b, 0x0101021c, 0x010104ea];
  const enc = strings.map((s) => {
    const b = Buffer.alloc(2 + s.length * 2 + 2);
    b.writeUInt16LE(s.length, 0);
    b.write(s, 2, 'utf16le');
    return b;
  });
  let body = Buffer.concat(enc);
  if (body.length % 4) body = Buffer.concat([body, Buffer.alloc(4 - (body.length % 4))]);
  const offs = Buffer.alloc(strings.length * 4);
  let at = 0;
  enc.forEach((b, i) => (offs.writeUInt32LE(at, i * 4), (at += b.length)));
  const sp = Buffer.alloc(28);
  sp.writeUInt16LE(0x0001, 0);
  sp.writeUInt16LE(28, 2);
  sp.writeUInt32LE(28 + offs.length + body.length, 4);
  sp.writeUInt32LE(strings.length, 8);
  sp.writeUInt32LE(28 + offs.length, 20);
  const rm = Buffer.alloc(8 + resIds.length * 4);
  rm.writeUInt16LE(0x0180, 0);
  rm.writeUInt16LE(8, 2);
  rm.writeUInt32LE(rm.length, 4);
  resIds.forEach((r, i) => rm.writeUInt32LE(r, 8 + i * 4));
  const attr = (name: number, raw: number, type: number, data: number) => {
    const a = Buffer.alloc(20);
    a.writeUInt32LE(0xffffffff, 0);
    a.writeUInt32LE(name, 4);
    a.writeUInt32LE(raw, 8);
    a.writeUInt16LE(8, 12);
    a[15] = type;
    a.writeUInt32LE(data, 16);
    return a;
  };
  const elem = (name: number, attrs: Buffer[]) => {
    const h = Buffer.alloc(36);
    h.writeUInt16LE(0x0102, 0);
    h.writeUInt16LE(16, 2);
    h.writeUInt32LE(36 + attrs.length * 20, 4);
    h.writeUInt32LE(0xffffffff, 12);
    h.writeUInt32LE(0xffffffff, 16);
    h.writeUInt32LE(name, 20);
    h.writeUInt16LE(20, 24);
    h.writeUInt16LE(20, 26);
    h.writeUInt16LE(attrs.length, 28);
    return Buffer.concat([h, ...attrs]);
  };
  const m = elem(4, [attr(0, 0xffffffff, 0x10, o.code), attr(1, 7, 0x03, 7), attr(3, 6, 0x03, 6)]);
  const app = elem(5, [attr(2, 0xffffffff, 0x12, o.extract ? 0xffffffff : 0)]);
  const doc = Buffer.concat([sp, offs, body, rm, m, app]);
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0);
  head.writeUInt16LE(8, 2);
  head.writeUInt32LE(8 + doc.length, 4);
  return Buffer.concat([head, doc]);
}

const node = (p: Partial<UiNode>): UiNode => ({ x1: 0, y1: 0, x2: 100, y2: 50, text: '', hint: '', desc: '', cls: 'android.view.View', clickable: false, ...p }) as UiNode;

describe('W3-4 E1 ③ APK files', () => {
  it('reads package / versionCode / versionName from a binary manifest', () => {
    expect(parseManifest(axml({ pkg: 'ai.teamily.mobile', code: 248, name: '2.1.5' }))).toEqual({ package: 'ai.teamily.mobile', versionCode: 248, versionName: '2.1.5' });
  });
  it('sets extractNativeLibs to true once (the emulator copy, V18)', () => {
    const m = axml({ pkg: 'a.b', code: 1, name: '1' });
    const p = patchExtractNativeLibs(m)!;
    expect(p).toBeDefined();
    expect(p.length).toBe(m.length);
    expect(patchExtractNativeLibs(p)).toBeUndefined();
    expect(parseManifest(p).versionCode).toBe(1);
  });
  it('installs only when the folder is newer (never downgrades)', () => {
    const set = { package: 'p', versionCode: 248, files: [], label: 'x' };
    expect(needsInstall(undefined, set)).toBe(true);
    expect(needsInstall({ versionCode: 247 }, set)).toBe(true);
    expect(needsInstall({ versionCode: 248 }, set)).toBe(false);
    expect(needsInstall({ versionCode: 300 }, set)).toBe(false);
    expect(needsInstall({ versionCode: 1 }, undefined)).toBe(false);
  });
  it.skipIf(!existsSync('apk/teamily'))('reads the real APKs in apk/teamily/ (when present)', () => {
    const { sets, errors } = apkSets();
    expect(errors).toEqual([]);
    for (const s of sets) expect(s.package).toBe('ai.teamily.mobile');
  });
});

describe('W3-4 E1 ①② AVD and snapshots', () => {
  it('patches config.ini keys in place and appends new ones', () => {
    expect(patchIni('a=1\nhw.ramSize=2G\nb=2\n', { 'hw.ramSize': '4G', 'PlayStore.enabled': 'yes' })).toBe('a=1\nhw.ramSize=4G\nb=2\nPlayStore.enabled=yes\n');
  });
  it('reads snapshot names from the emulator console', () => {
    const out = 'List of snapshots present on all disks:\r\r\nID        TAG                 VM SIZE                DATE       VM CLOCK\r\r\n--        teamily-ready           75M 2026-11-19 11:38:00   00:09:20.027\r\r\nOK\r\r\n';
    expect(parseSnapshots(out)).toEqual(['teamily-ready']);
    expect(parseSnapshots('There is no snapshot available.\nOK')).toEqual([]);
  });
});

describe('W3-4 E1 ⑦ device config (K8)', () => {
  it('parses the emulator block; port from the serial when absent; bad ports dropped', () => {
    expect(emulatorOf({ avd: 'TeamilyAvd', snapshot: 's', patchApk: true, locale: 'zh-CN' }, 'emulator-5556')).toEqual({ avd: 'TeamilyAvd', port: 5556, snapshot: 's', patchApk: true, locale: 'zh-CN' });
    expect(emulatorOf({ avd: 'x', port: 5555 }, 'emulator-5555')).toBeUndefined();
    expect(emulatorOf(undefined, 'emulator-5556')).toBeUndefined();
    const cfg = parsePoolConfig('devices:\n  - udid: emulator-5556\n    surfaces: [android-app]\n    accounts: { android-app: prod-aaron2 }\n    inputMode: keys\n    emulator: { avd: TeamilyAvd, port: 5556 }\n  - udid: 4f2ebdf2\n');
    expect(cfg.devices[0]).toMatchObject({ udid: 'emulator-5556', inputMode: 'keys', emulator: { avd: 'TeamilyAvd', port: 5556 }, capacity: { 'android-app': 1 } });
    expect(cfg.devices[1].emulator).toBeUndefined();
  });
  it('an emulator environment has no HyperOS item and installs the app from apk/teamily/', () => {
    const cfg = parsePoolConfig('devices:\n  - udid: emulator-5556\n    surfaces: [android-app]\n    accounts: { android-app: prod-aaron2 }\n    treeBackend: a11y-service\n    emulator: { avd: TeamilyAvd }\n  - udid: 4f2ebdf2\n    surfaces: [android-app]\n    accounts: { android-app: prod-aaron1 }\n');
    const envs = declareEnvs(cfg, [{ id: 'prod-aaron1', env: 'prod' }, { id: 'prod-aaron2', env: 'prod' }]);
    expect(envs.find((e) => e.device === 'emulator-5556')).toMatchObject({ id: 'android-app:emulator-5556@prod', emulator: true, account: 'prod-aaron2' });
    expect(envs.find((e) => e.device === '4f2ebdf2')?.emulator).toBeUndefined();
    expect(androidConfigItems('ai.teamily.mobile', 'a11y-service', true).map((c) => c.id)).toEqual(['a11y-service', 'apk', 'stayon']);
    expect(androidConfigItems('ai.teamily.mobile', undefined, false).map((c) => c.id)).toEqual(['taplus', 'stayon']);
  });
  it('the preflight reads the manufacturer (Xiaomi-only items gated, ⑥)', () => {
    expect(parseDeviceState('maker=Google\n').maker).toBe('Google');
    expect(parseDeviceState('maker=\n').maker).toBeUndefined();
  });
});

describe('W3-4 E1 ③④ forced update and sign-in on a fresh device', () => {
  it('a store / update page is a forced update; the app is not', () => {
    expect(forcedUpdate('mCurrentFocus=Window{1 u0 com.android.vending/com.google.android.finsky.activities.MainActivity}')).toBe(true);
    expect(forcedUpdate('mCurrentFocus=Window{1 u0 ai.teamily.mobile/ai.teamily.mobile.MainActivity}', ['发现新版本，请立即更新'])).toBe(true);
    expect(forcedUpdate('mCurrentFocus=Window{1 u0 ai.teamily.mobile/ai.teamily.mobile.MainActivity}', ['搜索', '会话'])).toBe(false);
  });
  it('a run that ends on a forced update is the environment, not the app', () => {
    expect(classifyFailure('失败' as any, '需要新版本 APK：Teamily 启动后被强制更新')).toMatchObject({ kind: 'env', rule: 'app-update' });
  });
  it('tells the login steps apart and finds the submit button', () => {
    const email = [node({ cls: 'android.widget.EditText', text: 'name@company.com', desc: 'Email address' }), node({ desc: 'Continue', cls: 'android.widget.Button', clickable: true })];
    expect(loginStep(email)).toBe('email');
    expect(submitButton(email)?.desc).toBe('Continue');
    expect(loginStep([node({ cls: 'android.widget.EditText', desc: 'Password' })])).toBe('password');
    expect(loginStep([node({ text: '搜索' })])).toBe('none');
  });
});

describe('W3-4 E1 ⑧ suite on a chosen environment', () => {
  it('parses environment ids', () => {
    expect(parseEnvId('android-app:emulator-5556@prod')).toEqual({ surface: 'android-app', device: 'emulator-5556', env: 'prod' });
    expect(parseEnvId('emulator-5556')).toBeUndefined();
  });
  it('{member} is never the account signed in on the device under test', () => {
    expect(memberFor({ member: 'aaron+test2', members: ['aaron+test2', 'aaron+test1'] }, 'aaron+test2')).toBe('aaron+test1');
    expect(memberFor({ member: 'aaron+test2', members: ['aaron+test2', 'aaron+test1'] }, 'aaron+test1')).toBe('aaron+test2');
    expect(memberFor({ member: 'aaron+test2' }, undefined)).toBe('aaron+test2');
    expect(memberFor({ member: 'aaron+test2' }, 'aaron+test2')).toBeUndefined();
  });
});

describe('W3-4 E1 doctor for emulators', () => {
  const base = (): Facts => ({
    node: { version: '22.1.0', missing: [] },
    platform: { up: true, url: 'http://localhost:3210/api/v1' },
    model: { text: true, vision: true },
    adb: { ok: true, path: 'adb' },
    devices: [],
    recorder: { scrcpy: true },
    envs: [],
    stale: { locks: [], forwards: [], leases: [] },
  });
  it('a stopped emulator → start it (a command, not a person)', () => {
    const f = base();
    f.devices = [{ udid: 'emulator-5556', state: 'absent', declared: true, backend: 'uiautomator', emulator: { avd: 'TeamilyAvd', avdExists: true, snapshot: 'teamily-ready' } }];
    const d = diagnose(f);
    expect(d.conclusion).toBe('blocked');
    expect(d.next[0]).toMatchObject({ kind: 'run', cmd: 'pnpm autotest emulator start' });
  });
  it('an emulator behind apk/teamily/ → warn with the env check that upgrades it', () => {
    const f = base();
    f.devices = [{ udid: 'emulator-5556', state: 'device', declared: true, locked: false, awake: true, backend: 'uiautomator', emulator: { avd: 'TeamilyAvd', avdExists: true, snapshot: 's', snapshotSaved: true, apk: { installed: '2.1.5（248）', newest: '2.1.6（250）', behind: true } } }];
    const d = diagnose(f);
    expect(d.conclusion).toBe('degraded');
    expect(d.checks.find((c) => c.id === 'device:emulator-5556')?.detail).toMatch(/要升级/);
    expect(d.next.some((n) => n.cmd === 'pnpm autotest env check android-app:emulator-5556@prod')).toBe(true);
  });
});
