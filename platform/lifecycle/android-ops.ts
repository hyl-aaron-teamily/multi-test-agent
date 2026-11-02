// Phone side of the environment check (refactor P2): online, screen, app version and the configuration items,
// over adb. No tree reads, no cleaning — every run starts from a clean point itself (executor/isolation.ts).
import { adb } from '../../core/adb';
import { a11yHealth, A11Y_PKG, enableA11y, installA11y } from '../../core/a11y-service';
import { parseDeviceState, taplusWith } from '../../executor/preflight';
import type { PhoneDriver } from './check';
import type { ConfigItem } from './env';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export function adbPhoneDriver(udid: string, pkg: string): PhoneDriver {
  const sh = (cmd: string, t = 10_000) => adb(['shell', cmd], udid, t);
  const state = async () => parseDeviceState(await sh("dumpsys power | grep -m1 'mWakefulness='; dumpsys window | grep -E -m3 'mCurrentFocus=|isKeyguardShowing|mDreamingLockscreen'; echo \"stayon=$(settings get global stay_on_while_plugged_in)\"; echo \"taplus=$(settings get global taplus_blacklist)\"", 15_000).catch(() => ''));
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
    appVersion: async () => (await sh(`dumpsys package ${pkg} | grep -m1 versionName=`, 10_000).catch(() => '')).match(/versionName=(\S+)/)?.[1],
  };
}
