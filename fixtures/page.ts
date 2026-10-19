// Playwright page + Midscene PlaywrightAgent per test, with Allure step/screenshot helpers.
// ref: midscene-example/playwright-with-vitest-demo/src/context/web.ts
//      (shared browser in beforeAll, new page + PlaywrightAgent in beforeEach, groupName/reportFileName)
// ref: midscene-example/playwright-demo/demo.ts (chromium.launch args, PlaywrightAgent(page))
import { existsSync } from 'node:fs';
import { PlaywrightAgent, type WebPageAgentOpt } from '@midscene/web/playwright';
import * as allure from 'allure-js-commons';
import { type Browser, type Page, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

const REQUIRED_MODEL_ENV = [
  'MIDSCENE_MODEL_BASE_URL',
  'MIDSCENE_MODEL_API_KEY',
  'MIDSCENE_MODEL_NAME',
  'MIDSCENE_MODEL_FAMILY',
] as const;

export class MissingModelCredentialsError extends Error {
  constructor(missing: string[]) {
    super(
      `[waiting for credentials] Midscene model config missing: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill in a vision-model endpoint, then rerun `pnpm test`.',
    );
    this.name = 'MissingModelCredentialsError';
  }
}

/** Throws a readable error instead of letting the AI call fail deep inside Midscene. */
export function assertModelCredentials(): void {
  const missing = REQUIRED_MODEL_ENV.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) throw new MissingModelCredentialsError(missing);
}

export interface WebContext {
  page: Page;
  agent: PlaywrightAgent;
}

export interface WebContextOptions {
  viewport?: { width: number; height: number };
  agentOptions?: Omit<WebPageAgentOpt, 'groupName' | 'reportFileName'>;
}

/**
 * Register lifecycle hooks; returned object's `page` / `agent` point at the current test.
 * Credentials are checked in beforeEach, so a missing .env fails every test with
 * MissingModelCredentialsError rather than being skipped.
 */
export function useWebContext(url: string, options: WebContextOptions = {}): WebContext {
  let browser: Browser | undefined;
  let current: WebContext | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
      args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
  });

  beforeEach(async (testCtx) => {
    assertModelCredentials();
    const page = await browser!.newPage({
      viewport: options.viewport ?? { width: 1280, height: 800 },
    });
    await page.goto(url);
    const suiteName = testCtx.task.suite?.name || 'UnnamedGroup';
    const agent = new PlaywrightAgent(page, {
      ...options.agentOptions,
      groupName: `E2E: ${suiteName}`,
      reportFileName: `E2E-${suiteName}-${testCtx.task.name}-${Date.now()}`.replace(/[^\w.-]+/g, '_'),
    });
    current = { page, agent };
  });

  afterEach(async () => {
    const ctx = current;
    current = undefined;
    if (!ctx) return;
    await ctx.agent.destroy();
    // Midscene's own HTML replay report: per-AI-call screenshots + model reasoning.
    const reportFile = ctx.agent.reportFile;
    if (reportFile && existsSync(reportFile)) {
      await allure.attachmentPath('Midscene report', reportFile, allure.ContentType.HTML);
    }
    await ctx.page.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  return {
    get page() {
      return current!.page;
    },
    get agent() {
      return current!.agent;
    },
  };
}

/**
 * Wrap a test step in an Allure step and attach a full-page screenshot after it,
 * on success and on failure, so a failed assertion is pinned to its step.
 */
export async function step<T>(page: Page, name: string, body: () => Promise<T>): Promise<T> {
  return allure.step(name, async () => {
    try {
      return await body();
    } finally {
      if (!page.isClosed()) {
        const png = await page.screenshot({ fullPage: true }).catch(() => undefined);
        if (png) await allure.attachment(`${name} — screenshot`, png, allure.ContentType.PNG);
      }
    }
  });
}
