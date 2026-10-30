// Production baseline drivers: the phone over adb (accessibility tree for where / composer — outside any
// test loop), and the host side (the last task's process tree).
import { adb, forceStopApp, launchApp } from '../../core/adb';
import { dumpTree, findByText, keyboardShown, nodeCenter, type UiNode } from '../../core/ui-tree';
import { parseDeviceState, taplusWith } from '../../executor/preflight';
import type { AndroidBaselineDriver, HostBaselineDriver } from './baseline';
import type { ConfigItem } from './env';
import { alive, killTree, type ProcId } from './proc';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Environment configuration items of an Android phone (§3.1): consented once at registration. */
export function androidConfigItems(pkg: string): ConfigItem[] {
  return [
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
  const tree = () => dumpTree(udid, pkg, 3);
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
      return { ok: true, detail: `${c.id}: 无检查` };
    },
    applyConfig: async (c) => {
      const s = await state();
      if (c.id === 'taplus') {
        const v = taplusWith(s.taplus, pkg);
        if (v) await sh(`settings put global taplus_blacklist '${v}'`);
      }
      if (c.id === 'stayon') await sh('svc power stayon usb');
    },
    residual: async () => {
      const out = await sh("ps -A -o PID,ARGS | grep -E 'yadb|uiautomator|app_process.* com.android.commands.input' | grep -v grep", 8000).catch(() => '');
      return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.slice(0, 80));
    },
    killResidual: async () => {
      await sh("for p in $(ps -A -o PID,ARGS | grep -E 'yadb|uiautomator|com.android.commands.input' | grep -v grep | awk '{print $1}'); do kill $p; done", 8000).catch(() => '');
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
