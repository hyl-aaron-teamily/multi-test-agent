// saucedemo login → inventory, 5 steps.
// AI locate (aiInput/aiTap) + structured query (aiQuery) + AI assertions (aiAssert/aiWaitFor),
// each key assertion backed by a native Playwright anchor.
// ref: midscene-example/playwright-with-vitest-demo/e2e/web/todo-list.test.ts (describe/it + ctx.agent shape)
// ref: midscene-example/playwright-demo/demo.ts (aiWaitFor / aiQuery<T> / aiTap / aiAssert usage)
// ref: playwright-mind/tests/bing-search-ai-example.spec.ts (act → aiQuery → expect length → aiAssert split)
import * as allure from 'allure-js-commons';
import { describe, expect, it } from 'vitest';
import { step, useWebContext } from '../../fixtures/page';

const BASE_URL = 'https://www.saucedemo.com';

describe('saucedemo login', () => {
  const ctx = useWebContext(BASE_URL);

  it('standard_user logs in and sees the product list', async () => {
    const { page, agent } = ctx;
    await allure.feature('Login');

    await step(page, '1. Open home page, login form is shown', async () => {
      await agent.aiAssert('There is a login form with a username input, a password input and a Login button');
      expect(await page.locator('#login-button').isVisible()).toBe(true);
    });

    await step(page, '2. Fill username and password (AI locate)', async () => {
      await agent.aiInput('the username input box', { value: 'standard_user' });
      await agent.aiInput('the password input box', { value: 'secret_sauce' });
      expect(await page.locator('#user-name').inputValue()).toBe('standard_user');
    });

    await step(page, '3. Click Login', async () => {
      await agent.aiTap('the Login button');
    });

    await step(page, '4. Wait for the product list page', async () => {
      await agent.aiWaitFor('The product list page is shown with several product cards', {
        timeoutMs: 30_000,
      });
      expect(page.url()).toContain('/inventory.html');
    });

    await step(page, '5. Assert "Products" title and at least 6 products', async () => {
      const info = await agent.aiQuery<{ title: string; productCount: number }>(
        '{title: string, productCount: number}, title is the page header text next to the sort dropdown, productCount is the number of product cards on the page',
      );
      await allure.attachment('aiQuery result', JSON.stringify(info, null, 2), allure.ContentType.JSON);
      expect(info.title).toBe('Products');
      expect(info.productCount).toBeGreaterThanOrEqual(6);

      await agent.aiAssert('The page title is "Products" and at least 6 products are listed');

      // Deterministic anchor: AI covers the long tail, native locator guards the core fact.
      expect(await page.locator('.inventory_item').count()).toBeGreaterThanOrEqual(6);
    });
  });
});
