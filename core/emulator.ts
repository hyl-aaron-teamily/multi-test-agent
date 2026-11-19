// Emulators as test devices (W3-4 E1 ①②, contract K8): create the Teamily AVD, start / stop it, snapshots.
// The emulator runs on this computer (WHPX); the platform — on the host or in a container — reaches it through
// the host adb server like the phone. Snapshot commands go through the emulator console via adb (`adb emu`).
// Never `adb kill-server` (the test phone would drop its USB-debugging authorization).
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { adb } from './adb';

const run = promisify(execFile);

export interface EmulatorDecl {
  avd: string;
  port: number;
  /** Snapshot holding「installed, signed in, tree service on」; restored when the platform starts. */
  snapshot?: string;
}

/** Spec of the Teamily AVD (same screen as the test phone: SKILL coordinates and skill-cache are per resolution).
 *  A Play Store image: the Teamily APK ships ARM libraries only, and only these x86_64 images translate ARM
 *  (V18, 2026-11-19: google_apis API 33 has abilist x86_64 only → INSTALL_FAILED_NO_MATCHING_ABIS). */
export const TEAMILY_AVD = {
  name: 'TeamilyAvd',
  image: 'system-images;android-34;google_apis_playstore;x86_64',
  device: 'pixel_6',
  config: { 'hw.ramSize': '4G', 'hw.gpu.enabled': 'yes', 'hw.gpu.mode': 'host', 'hw.lcd.width': '1080', 'hw.lcd.height': '2400', 'hw.lcd.density': '420', 'hw.keyboard': 'no', 'disk.dataPartition.size': '8G', 'PlayStore.enabled': 'yes' } as Record<string, string>,
};

export const sdkRoot = () => process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? (process.platform === 'win32' ? 'D:\\Android\\Sdk' : join(homedir(), 'Android', 'Sdk'));
export const avdHome = () => process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd');
const exe = (p: string) => (process.platform === 'win32' ? `${p}${p.endsWith('emulator') ? '.exe' : '.bat'}` : p);
export const emulatorBin = () => exe(join(sdkRoot(), 'emulator', 'emulator'));
const avdmanagerBin = () => exe(join(sdkRoot(), 'cmdline-tools', 'latest', 'bin', 'avdmanager'));
export const serialOf = (port: number) => `emulator-${port}`;
export const portOf = (serial: string) => Number(serial.match(/^emulator-(\d+)$/)?.[1]) || undefined;

export function avdExists(name: string): boolean {
  return existsSync(join(avdHome(), `${name}.ini`));
}

/** Pure: config.ini text with keys set (others kept, order kept, new keys appended). */
export function patchIni(text: string, set: Record<string, string>): string {
  const left = { ...set };
  const lines = text.split(/\r?\n/).map((l) => {
    const k = l.split('=')[0];
    if (k in left) {
      const v = left[k];
      delete left[k];
      return `${k}=${v}`;
    }
    return l;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return [...lines, ...Object.entries(left).map(([k, v]) => `${k}=${v}`), ''].join('\n');
}

/** The image is installed under the SDK. */
export function imageInstalled(image = TEAMILY_AVD.image): boolean {
  return existsSync(join(sdkRoot(), ...image.split(';')));
}

/** Create the AVD (avdmanager) and set the hardware of the spec. Existing AVD: only the config is patched. */
export async function createAvd(spec = TEAMILY_AVD): Promise<string> {
  if (!imageInstalled(spec.image)) throw new Error(`system image missing: ${spec.image}\n  install: sdkmanager "${spec.image}"`);
  if (!avdExists(spec.name)) {
    // avdmanager asks "custom hardware profile?" — answer no. Its devices.xml warning is harmless.
    const args = ['create', 'avd', '-n', spec.name, '-k', spec.image, '-d', spec.device];
    const p = process.platform === 'win32' ? spawn('cmd.exe', ['/c', avdmanagerBin(), ...args], { windowsHide: true }) : spawn(avdmanagerBin(), args);
    p.stdin.end('no\n');
    await new Promise((res) => p.on('close', res));
    if (!avdExists(spec.name)) throw new Error(`avdmanager did not create ${spec.name}`);
  }
  const cfg = join(avdHome(), `${spec.name}.avd`, 'config.ini');
  writeFileSync(cfg, patchIni(readFileSync(cfg, 'utf8'), spec.config));
  return cfg;
}

export async function bootCompleted(serial: string): Promise<boolean> {
  return (await adb(['shell', 'getprop', 'sys.boot_completed'], serial, 5000).catch(() => '')).trim() === '1';
}

/** Start the emulator detached (it outlives this process) and wait for boot. */
export async function startEmulator(e: EmulatorDecl, o: { headless?: boolean; timeoutMs?: number; log?: (s: string) => void } = {}): Promise<string> {
  const serial = serialOf(e.port);
  const log = o.log ?? (() => {});
  if (!(await bootCompleted(serial))) {
    if (!avdExists(e.avd)) throw new Error(`no AVD ${e.avd} (create: pnpm autotest emulator create)`);
    const args = ['-avd', e.avd, '-port', String(e.port), '-no-boot-anim', '-gpu', 'host', '-no-audio', ...(o.headless ? ['-no-window'] : []), ...(e.snapshot ? ['-snapshot', e.snapshot] : [])];
    log(`starting ${e.avd} on ${serial}`);
    spawn(emulatorBin(), args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    const until = Date.now() + (o.timeoutMs ?? 240_000);
    while (!(await bootCompleted(serial))) {
      if (Date.now() > until) throw new Error(`${serial} did not boot in ${Math.round((o.timeoutMs ?? 240_000) / 1000)} s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return serial;
}

/** Emulator console command over adb (`adb -s emulator-N emu …`). */
export async function emu(serial: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const out = await adb(['emu', ...args], serial, timeoutMs);
  if (/^KO/m.test(out)) throw new Error(`emu ${args.join(' ')}: ${out.trim()}`);
  return out;
}

export async function stopEmulator(serial: string): Promise<void> {
  await emu(serial, ['kill'], 20_000).catch(() => {});
}

export const saveSnapshot = (serial: string, name: string) => emu(serial, ['avd', 'snapshot', 'save', name]);

/** Restore a snapshot (the app, its sign-in and the tree service come back as saved). */
export async function loadSnapshot(serial: string, name: string): Promise<void> {
  await emu(serial, ['avd', 'snapshot', 'load', name]);
  for (let i = 0; i < 30 && !(await bootCompleted(serial)); i++) await new Promise((r) => setTimeout(r, 1000));
}

/** Pure: names from `emu avd snapshot list`. */
export function parseSnapshots(out: string): string[] {
  // `ID  TAG  VM SIZE  DATE  VM CLOCK` rows; the ID column may be `--`.
  return out.split(/\r?\n/).map((l) => l.trim().match(/^(?:--|\d+)\s+(\S+)\s+\S+\s+\d{4}-\d\d-\d\d/)?.[1]).filter((x): x is string => !!x);
}

export async function listSnapshots(serial: string): Promise<string[]> {
  return parseSnapshots(await emu(serial, ['avd', 'snapshot', 'list']).catch(() => ''));
}

/** Manufacturer of a device (Xiaomi-only preflight items are skipped elsewhere, W3-4 E1 ⑥). */
export async function manufacturer(serial: string): Promise<string> {
  return (await adb(['shell', 'getprop', 'ro.product.manufacturer'], serial, 5000).catch(() => '')).trim();
}

export const isXiaomi = (m: string | undefined) => /xiaomi|redmi|poco/i.test(m ?? '');

/** The host emulator binary runs (for doctor). */
export async function emulatorVersion(): Promise<string | undefined> {
  if (!existsSync(emulatorBin())) return undefined;
  return (await run(emulatorBin(), ['-version'], { timeout: 15_000, windowsHide: true }).catch(() => ({ stdout: '' }))).stdout.split(/\r?\n/)[0]?.trim() || undefined;
}
