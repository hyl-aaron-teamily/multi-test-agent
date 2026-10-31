// Production baseline drivers: the phone over adb (accessibility tree for where / composer — outside any
// test loop), and the host side (the last task's process tree).
import { adb, forceStopApp, launchApp } from '../../core/adb';
import { a11yHealth, A11Y_PKG, enableA11y, installA11y } from '../../core/a11y-service';
import { dumpTree, findByText, keyboardShown, nodeCenter, type UiNode } from '../../core/ui-tree';
import { parseDeviceState, taplusWith } from '../../executor/preflight';
import { selectTreeBackend } from '../../executor/session';
import type { AndroidBaselineDriver, HostBaselineDriver } from './baseline';
import type { ConfigItem } from './env';
import { alive, killTree, type ProcId } from './proc';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-flight reads younger than this are not leftovers (2026-10-31: a check killed its sibling's live dump). */
export const RESIDUAL_MIN_AGE_S = 20;

/** Pure: `[[dd-]hh:]mm:ss` → seconds. */
export function etimeSeconds(e: string): number {
  const [d, rest] = e.includes('-') ? e.split('-') : ['0', e];
  return rest.split(':').map(Number).reduce((a, n) => a * 60 + n, 0) + Number(d) * 86400;
}

/** Pure: helper processes (yadb, uiautomator, input) in `ps -A -o PID,ETIME,ARGS` output older than the minimum age. */
export function residualHelpers(ps: string, minAgeS = RESIDUAL_MIN_AGE_S): { pid: string; ageS: number; args: string }[] {
  return ps
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && /yadb|uiautomator|com\.android\.commands\.input/.test(m[3]) && !/\bgrep\b|\bps -A\b/.test(m[3]))
    .map((m) => ({ pid: m[1], ageS: etimeSeconds(m[2]), args: m[3] }))
    .filter((h) => h.ageS >= minAgeS);
}

/** Environment configuration items of an Android phone (§3.1): consented once at registration. */
export function androidConfigItems(pkg: string, treeBackend?: 'uiautomator' | 'a11y-service'): ConfigItem[] {
  return [
    ...(treeBackend === 'a11y-service'
      ? [{ id: 'a11y-service', what: `安装并启用只读无障碍服务 ${A11Y_PKG}（只导出界面树，不做手势、不外发数据）`, why: '读界面树从 uiautomator 每次 2.5–3.7 s 降到常驻服务即时返回', restore: `关闭该无障碍服务并卸载：autotest 环境配置项撤销，或 adb uninstall ${A11Y_PKG}`, optional: true }]
      : []),
    { id: 'taplus', what: `HyperOS「文本识别」(Taplus) 对 ${pkg} 关闭：把它加入 global taplus_blacklist`, why: 'Taplus 抢长按手势，弹出浮层，长按类用例无法执行', restore: '从 taplus_blacklist 移除该包名（系统也会自行还原；每次预检重写）' },
    { id: 'stayon', what: 'USB 充电时屏幕常亮：stay_on_while_plugged_in 含 USB 位', why: '运行中熄屏会让任务停住', restore: 'settings put global stay_on_while_plugged_in 0' },
  ];
}

/** Pure: is this tree the app's home list / a chat page / a popup? */
export function whereOf(nodes: UiNode[], focus: string, pkg: string): 'home' | 'chat' | 'popup' | 'foreign' | 'unknown' {
  if (!focus.includes(pkg)) return /Keyguard|NotificationShade/i.test(focus) ? 'unknown' : 'foreign';
  if (!/MainActivity/.test(focus)) return 'popup';
  const edit = nodes.some((n) => /EditText/.test(n.cls));
  const nav = nodes.some((n) => n.desc === '聊天' && /Button/.test(n.cls));
  const search = nodes.some((n) => n.desc === '搜索' || n.text === '搜索');
  if (!edit && nav && search) return 'home';
  if (edit && !nav) return 'chat';
  return nodes.length ? 'popup' : 'unknown';
}

export function adbBaselineDriver(udid: string, pkg: string): AndroidBaselineDriver {
  const sh = (cmd: string, t = 10_000) => adb(['shell', cmd], udid, t);
  const state = async () => parseDeviceState(await sh("dumpsys power | grep -m1 'mWakefulness='; dumpsys window | grep -E -m3 'mCurrentFocus=|isKeyguardShowing|mDreamingLockscreen'; echo \"ime=$(settings get secure default_input_method)\"; echo \"stayon=$(settings get global stay_on_while_plugged_in)\"; echo \"taplus=$(settings get global taplus_blacklist)\"", 15_000).catch(() => ''));
  // Tree reads use the device's declared backend (the tree service when installed), like the runs do.
  let backend: Promise<void> | undefined;
  const tree = async () => {
    await (backend ??= selectTreeBackend(udid, () => {}).catch(() => {}));
    return dumpTree(udid, pkg, 3);
  };
  // Helper processes left on the phone, older than RESIDUAL_MIN_AGE_S: a younger one is an in-flight read of a
  // sibling environment on the same phone (android-app and android-web recover / check independently).
  const helpers = async () => residualHelpers(await sh('ps -A -o PID,ETIME,ARGS', 8000).catch(() => ''));
  return {
    online: async () => (await adb(['get-state'], udid, 5000).catch(() => '')).trim() === 'device',
    screen: async () => {
      const s = await state();
      return { awake: /awake/i.test(s.wakefulness ?? ''), locked: !!s.keyguard || /Keyguard|NotificationShade/i.test(s.focus ?? '') };
    },
    wake: async () => {
      await sh('input keyevent 224');
      await sleep(700);
    },
    where: async () => whereOf(await tree(), (await state()).focus ?? '', pkg),
    back: async () => {
      await sh('input keyevent 4');
      await sleep(900);
    },
    restartApp: async () => {
      await forceStopApp(pkg, udid);
      await sleep(800);
      await launchApp(pkg, udid);
      await sleep(5000);
    },
    openConversation: async (name) => {
      for (let i = 0; i < 3; i++) {
        const nodes = await tree();
        const f = findByText(nodes, name);
        if (f && f.how === 'exact') {
          const p = nodeCenter(f.node);
          await sh(`input tap ${p.x} ${p.y}`);
          await sleep(1800);
          return whereOf(await tree(), (await state()).focus ?? '', pkg) === 'chat';
        }
        await sh('input swipe 540 1700 540 900 300');
        await sleep(800);
      }
      return false;
    },
    composer: async () => {
      const e = (await tree()).filter((n) => /EditText/.test(n.cls)).sort((a, b) => b.y1 - a.y1)[0];
      return e ? (e.text === e.hint ? '' : e.text) : null;
    },
    clearComposer: async () => {
      const e = (await tree()).filter((n) => /EditText/.test(n.cls)).sort((a, b) => b.y1 - a.y1)[0];
      if (!e) return;
      const p = nodeCenter(e);
      await sh(`input tap ${p.x} ${p.y}`);
      await sleep(500);
      await sh('input keycombination 113 29');
      await sh('input keyevent 67');
      await sleep(500);
    },
    keyboard: () => keyboardShown(udid),
    hideKeyboard: async () => {
      await sh('input keyevent 111');
      await sleep(400);
      if ((await keyboardShown(udid)) === true) {
        await sh('input keyevent 4');
        await sleep(400);
      }
    },
    ime: async () => (await state()).ime || undefined,
    setIme: async (id) => {
      await sh(`ime set ${id}`);
    },
    configOk: async (c) => {
      const s = await state();
      if (c.id === 'taplus') {
        const ok = taplusWith(s.taplus, pkg) === undefined && !!s.taplus && s.taplus !== 'null';
        return { ok, detail: ok ? `Taplus 黑名单含 ${pkg}` : `Taplus 黑名单不含 ${pkg}（系统已还原）` };
      }
      if (c.id === 'stayon') {
        const ok = s.stayOn !== undefined && !!(s.stayOn & 2);
        return { ok, detail: `stay_on_while_plugged_in=${s.stayOn ?? '?'}` };
      }
      if (c.id === 'a11y-service') {
        const h = await a11yHealth(udid);
        return { ok: h.responding, detail: `读树服务：${h.detail}` };
      }
      return { ok: true, detail: `${c.id}: 无检查` };
    },
    applyConfig: async (c) => {
      const s = await state();
      if (c.id === 'taplus') {
        const v = taplusWith(s.taplus, pkg);
        if (v) await sh(`settings put global taplus_blacklist '${v}'`);
      }
      if (c.id === 'stayon') await sh('svc power stayon usb');
      if (c.id === 'a11y-service') {
        const h0 = await a11yHealth(udid);
        if (!h0.installed || h0.outdated) {
          await installA11y(udid);
          // Enabled right after install, the component may not be registered yet and the system drops it.
          await sleep(3000);
        }
        for (let i = 0; i < 3 && !(await a11yHealth(udid)).responding; i++) {
          await enableA11y(udid);
          await sleep(2500);
        }
      }
    },
    residual: async () => (await helpers()).map((h) => `${h.pid} ${h.args}`.slice(0, 80)),
    killResidual: async () => {
      const pids = (await helpers()).map((h) => h.pid);
      if (pids.length) await sh(`kill ${pids.join(' ')}`, 8000).catch(() => '');
      await sleep(300);
    },
    appRunning: async () => /\d/.test(await sh(`pidof ${pkg}`, 8000).catch(() => '')),
    stopApp: async () => {
      await forceStopApp(pkg, udid);
      await sleep(800);
    },
    appVersion: async () => (await sh(`dumpsys package ${pkg} | grep -m1 versionName=`, 10_000).catch(() => '')).match(/versionName=(\S+)/)?.[1],
  };
}

/** The host side: is the last task's process (pid + start time) still running? */
export function hostDriver(proc: ProcId | undefined, sessionOk?: HostBaselineDriver['sessionOk']): HostBaselineDriver {
  return {
    taskProcesses: async () => (proc && alive(proc) ? [`pid ${proc.pid}`] : []),
    killTaskProcesses: async () => {
      if (proc) killTree(proc.pid);
      await sleep(1500);
    },
    sessionOk,
  };
}
