// Android native flow: Settings → About phone, each step an Allure step with a device screenshot.
// ref: midscene-example/android/vitest-demo/tests/todo.test.ts (beforeAll agent setup, describe/it layout)
// ref: tests/web/saucedemo.login.spec.ts + fixtures/page.ts (week-1 Allure step + screenshot pattern)
import { existsSync } from 'node:fs';
import * as allure from 'allure-js-commons';
import { afterAll, describe, it } from 'vitest';
import { type AndroidContext, createAndroidAgent, forceStopApp, launchApp, screencap } from '../../fixtures/android';
import { SETTINGS_PACKAGE, runSettingsAboutFlow, type StepRunner } from '../../android/flows/settings-about';

describe('android settings', () => {
  let ctx: AndroidContext | undefined;

  afterAll(async () => {
    if (!ctx) return;
    await ctx.agent.destroy();
    const reportFile = ctx.agent.reportFile;
    if (reportFile && existsSync(reportFile)) {
      await allure.attachmentPath('Midscene report', reportFile, allure.ContentType.HTML);
    }
  });

  it('opens About phone and reads device info', async () => {
    // Created inside the test (not beforeAll) so a missing device / credential fails this
    // test with a readable error instead of reporting it as skipped.
    ctx = await createAndroidAgent(undefined, {
      groupName: 'Android: settings',
      reportFileName: `android-settings-about-${Date.now()}`,
    });
    const { agent, udid } = ctx;
    await allure.feature('Android native');
    await allure.parameter('udid', udid);

    // Allure step + screenshot after the step, on success or failure.
    const step: StepRunner = (name, body) =>
      Promise.resolve(allure.step(name, async () => {
        try {
          return await body();
        } finally {
          const png = await screencap(udid).catch(() => undefined);
          if (png) await allure.attachment(`${name} — screenshot`, png, allure.ContentType.PNG);
        }
      }));

    await step('0. Force-stop and launch Settings', async () => {
      await forceStopApp(SETTINGS_PACKAGE, udid);
      await launchApp(SETTINGS_PACKAGE, udid);
    });

    const info = await runSettingsAboutFlow(agent, step, udid);
    await allure.attachment('aiQuery result', JSON.stringify(info, null, 2), allure.ContentType.JSON);
  });
});
