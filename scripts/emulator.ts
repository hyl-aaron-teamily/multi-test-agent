// `pnpm autotest emulator <create|prepare|start|stop|snapshot|reset|status> [udid]` (W3-4 E1 ②).
// The device defaults to the first emulator declared in platform/devices.yaml (`emulator: {avd, port, …}`).
//   create            create the AVD (Teamily spec) if missing and set its hardware
//   prepare           cold AVD → newest APK, app locale, tree service, signed in → snapshot   (a person only drops the APK)
//   start [--fresh]   boot (from the snapshot unless --fresh); stop: shut it down (idle environments are closed)
//   snapshot [name]   save the current state; reset: back to the snapshot
//   status            online, AVD, snapshot, APK installed vs newest in apk/teamily/
import 'dotenv/config';
import { avdExists, bootCompleted, listSnapshots, loadSnapshot, saveSnapshot, serialOf, startEmulator, stopEmulator } from '../core/emulator';
import { declaredEmulators } from '../platform/device-pool';
import { apkState, prepareEmulator } from '../platform/emulator-ops';

const [cmd = 'status', ...rest] = process.argv.slice(2);
const pos = rest.filter((a) => !a.startsWith('--'));
const flag = (n: string) => rest.includes(`--${n}`);
const log = (s: string) => console.log(`[emulator] ${s}`);

async function main(): Promise<number> {
  const all = declaredEmulators();
  const udid = pos.find((a) => /^emulator-\d+$/.test(a));
  const d = udid ? all.find((x) => x.udid === udid) : all[0];
  if (!d) {
    console.error(`no emulator declared in platform/devices.yaml${udid ? ` as ${udid}` : ''} (a device entry with emulator: {avd, port})`);
    return 2;
  }
  const e = d.emulator;
  const serial = serialOf(e.port);
  switch (cmd) {
    case 'create': {
      const { createAvd, TEAMILY_AVD } = await import('../core/emulator');
      log(`config: ${await createAvd({ ...TEAMILY_AVD, name: e.avd })}`);
      return 0;
    }
    case 'prepare': {
      const did = await prepareEmulator({ udid: d.udid, emulator: e, account: d.account, headless: flag('headless'), log });
      for (const x of did) log(`✓ ${x}`);
      return 0;
    }
    case 'start':
      await startEmulator({ ...e, snapshot: flag('fresh') ? undefined : e.snapshot }, { headless: flag('headless'), log });
      log(`${serial} up`);
      return 0;
    case 'stop':
      await stopEmulator(serial);
      log(`${serial} stopped`);
      return 0;
    case 'snapshot': {
      const name = pos.find((a) => a !== udid) ?? e.snapshot;
      if (!name) throw new Error('no snapshot name (devices.yaml emulator.snapshot or an argument)');
      await saveSnapshot(serial, name);
      log(`saved snapshot ${name}`);
      return 0;
    }
    case 'reset':
      if (!e.snapshot) throw new Error('devices.yaml declares no emulator.snapshot');
      await loadSnapshot(serial, e.snapshot);
      log(`${serial} back to ${e.snapshot}`);
      return 0;
    case 'status': {
      const up = await bootCompleted(serial);
      const snaps = up ? await listSnapshots(serial) : [];
      const a = up ? await apkState(serial) : undefined;
      const out = { udid: d.udid, avd: e.avd, avdExists: avdExists(e.avd), online: up, snapshot: e.snapshot, snapshotSaved: e.snapshot ? snaps.includes(e.snapshot) : undefined, apk: a };
      if (flag('json')) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`${d.udid}  AVD ${e.avd}${out.avdExists ? '' : '（不存在：pnpm autotest emulator create）'}  ${up ? '在线' : '未启动'}`);
        if (up) console.log(`  快照 ${e.snapshot ?? '-'}：${out.snapshotSaved ? '已保存' : '没有（pnpm autotest emulator prepare）'}`);
        if (a) console.log(`  Teamily：装的 ${a.installed?.versionName ?? '无'}（${a.installed?.versionCode ?? '-'}），apk/teamily/ 最新 ${a.newest ? `${a.newest.versionName}（${a.newest.versionCode}，${a.newest.label}）` : '无'}${a.behind ? ' → 需要升级' : ''}${a.errors.length ? `；读不出：${a.errors.join('；')}` : ''}`);
      }
      return 0;
    }
    default:
      console.error('usage: pnpm autotest emulator <create|prepare|start|stop|snapshot|reset|status> [emulator-N] [--fresh] [--headless] [--json]');
      return 2;
  }
}

main().then((c) => process.exit(c), (err) => {
  console.error((err as Error).message);
  process.exit(1);
});
