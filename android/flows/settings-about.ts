// System Settings → About phone: 5-step native flow shared by the Vitest spec and the loop script.
// Assumes Settings was just (re)launched. Uses node:assert, not vitest expect, so it runs outside the runner.
// ref: midscene-example/android/vitest-demo/tests/setting.test.ts (Settings package, aiAct on lists)
// ref: midscene-example/android/javascript-sdk-demo/demo.ts (aiWaitFor / aiQuery / aiAssert on Android)
// ref: @midscene/core agent.d.ts — aiAct / aiWaitFor / aiQuery<T> / aiAssert signatures
import assert from 'node:assert/strict';
import type { AndroidAgent } from '@midscene/android';
import { adb } from '../../core/adb';

export const SETTINGS_PACKAGE = 'com.android.settings';

/** Wraps one business step; the caller decides how to report it (Allure step, console, crash context). */
export type StepRunner = <T>(name: string, body: () => Promise<T>) => Promise<T>;

export interface AboutPhoneInfo {
  deviceName: string;
  androidVersion: string;
}

export async function runSettingsAboutFlow(
  agent: AndroidAgent,
  step: StepRunner,
  udid: string,
): Promise<AboutPhoneInfo> {
  await step('1. Settings home is shown', async () => {
    // Wait, not assert: right after a cold launch the first frames are blank.
    await agent.aiWaitFor('This is the system Settings app home screen: there is a "Settings" title or a settings search box', {
      timeoutMs: 20_000,
    });
  });

  await step('2. Open "About phone"', async () => {
    await agent.aiAct(
      'Scroll the settings list until the "About phone" entry is visible (it may be named "About device", "My phone", "关于手机" or "我的设备"), then tap it',
    );
  });

  await step('3. Wait for the About page (open the specs sub page if needed)', async () => {
    await agent.aiWaitFor('The About phone / device information page is shown, listing items such as device name, model or Android version', {
      timeoutMs: 30_000,
    });
    // Some skins (e.g. Xiaomi HyperOS 「我的设备」) only show the Android version on a sub page;
    // aiQuery cannot navigate, so open it here when needed.
    await agent.aiAct(
      'If an "Android version" / "Android 版本" value is already visible, do nothing. Otherwise scroll down and open the entry that lists all specs, such as "全部参数与信息", "All specs" or "Software information", until the Android version is visible.',
    );
  });

  const info = await step('4. Extract device name and Android version', async () => {
    const result = await agent.aiQuery<AboutPhoneInfo>(
      '{deviceName: string, androidVersion: string}, deviceName is the device or model name shown on this page; androidVersion is the Android version number (e.g. "14"). Use an empty string only if the value is truly not on screen.',
    );
    return result;
  });

  await step('5. Assert extracted values are not empty', async () => {
    assert.ok(info?.deviceName?.trim(), `aiQuery returned empty deviceName: ${JSON.stringify(info)}`);
    assert.ok(info?.androidVersion?.trim(), `aiQuery returned empty androidVersion: ${JSON.stringify(info)}`);
    // Deterministic anchor: the version the AI read must match what the device reports.
    const actual = (await adb(['shell', 'getprop', 'ro.build.version.release'], udid)).trim();
    assert.ok(
      info.androidVersion.includes(actual) || actual.startsWith(info.androidVersion.trim()),
      `AI read Android version "${info.androidVersion}", device reports "${actual}"`,
    );
    await agent.aiAssert(`The page shows the device information, including the name "${info.deviceName}"`);
  });

  return info;
}
