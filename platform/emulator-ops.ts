// Teamily emulator preparation and upkeep (W3-4 E1 ②–⑤): from a cold AVD to「newest APK installed, signed in,
// tree service on」, saved as a snapshot; the platform restores that snapshot when it starts (every start is a
// fresh platform). A person only drops APK files into apk/teamily/.
import { adb, launchApp } from '../core/adb';
import { a11yHealth, enableA11y, installA11y } from '../core/a11y-service';
import { apkSets, emulatorCopy, installedVersion, installSet, needsInstall, type ApkSet } from '../core/apk';
import { bootCompleted, createAvd, listSnapshots, loadSnapshot, saveSnapshot, serialOf, startEmulator, TEAMILY_AVD } from '../core/emulator';
import { TEAMILY_PACKAGE } from '../drivers/factory';
import { loginApp } from '../engine/login/app-login';
export { forcedUpdate } from '../engine/app-update';
import type { EmulatorConfig } from './device-pool';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ApkState {
  installed?: { versionCode: number; versionName?: string };
  newest?: Pick<ApkSet, 'versionCode' | 'versionName' | 'label'>;
  /** The device is older than the newest set in apk/teamily/. */
  behind: boolean;
  errors: string[];
}

export async function apkState(udid: string, pkg = TEAMILY_PACKAGE): Promise<ApkState> {
  const { sets, errors } = apkSets();
  const newest = sets.find((s) => s.package === pkg);
  const installed = await installedVersion(udid, pkg);
  return { installed, newest: newest && { versionCode: newest.versionCode, versionName: newest.versionName, label: newest.label }, behind: needsInstall(installed, newest), errors };
}

/** Install / upgrade to the newest set (never downgrades). Returns what was done, or undefined. */
export async function upgradeApp(udid: string, e: Pick<EmulatorConfig, 'patchApk'>, pkg = TEAMILY_PACKAGE, log: (s: string) => void = () => {}): Promise<string | undefined> {
  const newest = apkSets().sets.find((s) => s.package === pkg);
  const installed = await installedVersion(udid, pkg);
  if (!needsInstall(installed, newest)) return undefined;
  const set = e.patchApk ? await emulatorCopy(newest!) : newest!;
  log(`installing ${set.label} (${newest!.versionName ?? newest!.versionCode}) over ${installed ? installed.versionName ?? installed.versionCode : 'nothing'}`);
  try {
    await installSet(udid, set);
  } catch (err) {
    // A re-signed copy cannot replace an install with another signature (and the reverse): reinstall.
    if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test((err as Error).message)) throw err;
    log('signature differs from the installed app — uninstalling first (the sign-in is lost; prepare signs in again)');
    await adb(['uninstall', pkg], udid, 60_000);
    await installSet(udid, set);
  }
  return `安装 ${pkg} ${newest!.versionName ?? ''}（${newest!.versionCode}，来自 apk/teamily/${newest!.label}${e.patchApk ? '，模拟器副本' : ''}）`;
}

export async function setAppLocale(udid: string, locale: string, pkg = TEAMILY_PACKAGE): Promise<void> {
  await adb(['shell', `cmd locale set-app-locales ${pkg} --locales ${locale}`], udid, 15_000);
}

export interface PrepareOptions {
  udid: string;
  emulator: EmulatorConfig;
  account?: string;
  headless?: boolean;
  log?: (s: string) => void;
}

/** Cold AVD → snapshot. Every step is skipped when already done; the snapshot is saved at the end. */
export async function prepareEmulator(o: PrepareOptions): Promise<string[]> {
  const log = o.log ?? ((s: string) => console.log(`[emulator] ${s}`));
  const did: string[] = [];
  const e = o.emulator;
  const serial = serialOf(e.port);
  if (serial !== o.udid) throw new Error(`devices.yaml: ${o.udid} declares port ${e.port} (that is ${serial})`);
  if (e.avd === TEAMILY_AVD.name) {
    await createAvd({ ...TEAMILY_AVD, name: e.avd });
    did.push(`AVD ${e.avd} 已就绪（${TEAMILY_AVD.image}）`);
  }
  // Boot cold, not from the snapshot being rebuilt.
  await startEmulator({ avd: e.avd, port: e.port }, { headless: o.headless, log });
  const up = await upgradeApp(serial, e, TEAMILY_PACKAGE, log);
  if (up) did.push(up);
  if (!(await installedVersion(serial, TEAMILY_PACKAGE))) throw new Error('Teamily is not installed and apk/teamily/ has no APK for it: drop the APK there first');
  if (e.locale) {
    await setAppLocale(serial, e.locale);
    did.push(`App 语言 ${e.locale}`);
  }
  // W3-7 E5 ②: the emulator has a hardware keyboard, so the soft keyboard never shows and "the composer took
  // focus" (keyboard up) is never seen. Show it anyway: focus reads the same as on the phone.
  await adb(['shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1'], serial, 15_000);
  did.push('软键盘随硬键盘显示');
  const h0 = await a11yHealth(serial);
  if (!h0.installed || h0.outdated) {
    await installA11y(serial);
    await sleep(3000);
    did.push('安装读树服务');
  }
  for (let i = 0; i < 3 && !(await a11yHealth(serial)).responding; i++) {
    await enableA11y(serial);
    await sleep(2500);
  }
  const h = await a11yHealth(serial);
  did.push(`读树服务：${h.detail}`);
  await adb(['shell', `am force-stop ${TEAMILY_PACKAGE}`], serial);
  await launchApp(TEAMILY_PACKAGE, serial);
  await sleep(10_000);
  if (o.account) {
    const { AccountPool } = await import('./accounts/account-pool');
    const pool = new AccountPool();
    await pool.reload();
    const r = await loginApp(serial, TEAMILY_PACKAGE, pool.backend.get(o.account), log);
    did.push(r === 'logged-in' ? `登录 ${o.account}` : `已登录（${o.account}）`);
    await pool.markLogin(o.account, true).catch(() => {});
  }
  await adb(['shell', 'input keyevent 3'], serial); // home: the snapshot does not hold the app in a half state
  await adb(['shell', 'svc power stayon true'], serial).catch(() => '');
  if (e.snapshot) {
    await saveSnapshot(serial, e.snapshot);
    did.push(`保存快照 ${e.snapshot}`);
  }
  return did;
}

/** Platform start: an emulator that is up goes back to its snapshot (W3-4 E1 ②). A stopped one stays stopped
 *  (idle environments are closed); `emulator start` boots it from the snapshot. */
export async function restoreOnStart(list: { udid: string; emulator: EmulatorConfig }[], log: (s: string) => void): Promise<void> {
  for (const d of list) {
    if (!d.emulator.snapshot || !(await bootCompleted(d.udid))) continue;
    const snaps = await listSnapshots(d.udid);
    if (!snaps.includes(d.emulator.snapshot)) {
      log(`${d.udid}: no snapshot ${d.emulator.snapshot} (pnpm autotest emulator prepare)`);
      continue;
    }
    await loadSnapshot(d.udid, d.emulator.snapshot).then(() => log(`${d.udid}: restored snapshot ${d.emulator.snapshot}`), (err) => log(`${d.udid}: snapshot restore failed — ${(err as Error).message.split('\n')[0]}`));
    // A snapshot saved before W3-7 E5 has the soft keyboard hidden: set it after every restore (idempotent).
    await adb(['shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1'], d.udid, 15_000).catch(() => {});
  }
}
