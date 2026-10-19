// On-device self-check for the logcat crash monitor. No model credentials needed.
//   pnpm crash-check:android                     # default target com.android.settings
//   APP_PACKAGE=com.example.app pnpm crash-check:android
// Steps: start monitor → force-stop + launch app → `adb shell am crash <pkg>` → wait for the
// crash scene to be written to midscene_run/crashes/<timestamp>/ → print it. Exit 1 if nothing captured.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_PACKAGE } from '../android/flows/settings-about';
import { adb } from '../core/adb';
import { type CrashEvent, startLogcatMonitor } from '../core/logcat-monitor';
import { forceStopApp, getAndroidDevice, launchApp } from '../fixtures/android';

const appPackage = process.env.APP_PACKAGE ?? SETTINGS_PACKAGE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { udid } = await getAndroidDevice();
  console.log(`[crash-check] device ${udid}, package ${appPackage}`);

  let captured: CrashEvent | undefined;
  const monitor = startLogcatMonitor({ udid, packageName: appPackage, onCrash: (e) => void (captured ??= e) });
  monitor.setContext({ iteration: 1, step: 'crash-check: am crash' });

  await sleep(1_000); // let logcat attach before anything happens
  await forceStopApp(appPackage, udid);
  await launchApp(appPackage, udid);
  await sleep(2_500);
  console.log(`[crash-check] adb shell am crash ${appPackage}`);
  await adb(['shell', 'am', 'crash', appPackage], udid);

  for (let i = 0; i < 20 && !captured; i++) await sleep(500);
  await monitor.stop();

  if (!captured) {
    console.error('[crash-check] FAILED: no crash captured by the logcat monitor');
    process.exit(1);
  }
  console.log(`[crash-check] captured → ${captured.dir}`);
  console.log(`files: ${captured.files.join(', ')}`);
  console.log(readFileSync(join(captured.dir, 'context.json'), 'utf8'));
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
