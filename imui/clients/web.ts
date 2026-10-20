// Web UI client: chat-web in Chromium (Playwright) with a saved login state (storageState), the same
// approach as im-loadtest probe/ (session file) — imui never handles passwords.
//   open   : load the app, click the conversation by its visible name
//   send   : focus the composer, insert text, press Enter
//   watch  : a MutationObserver inside the page reports tokens the moment they enter the DOM
//            (event-driven, resolution ≈ 0; browser Date.now shares the host clock)
import { existsSync } from 'node:fs';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { leadingToken } from '../tokens';
import type { SeenHandler, UiClient } from './types';

export interface WebClientOptions {
  /** Id suffix, e.g. env name or account alias. */
  name: string;
  appUrl: string;
  /** Playwright storageState JSON produced by `imui login`. Optional for selftest pages. */
  statePath?: string;
  headless?: boolean;
  /** Composer selector override (default: last visible contenteditable or textarea). */
  inputSelector?: string;
}

const COMPOSER = '[contenteditable="true"], textarea';

export class WebClient implements UiClient {
  readonly kind = 'web' as const;
  readonly id: string;
  readonly resolutionMs = 0;
  private browser?: Browser;
  private context?: BrowserContext;
  page?: Page;
  private onSeen?: SeenHandler;
  private runId = '';

  constructor(private readonly o: WebClientOptions) {
    this.id = `web:${o.name}`;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    if (this.o.statePath && !existsSync(this.o.statePath)) {
      throw new Error(`${this.id}: no login state at ${this.o.statePath} — run \`pnpm autotest imui login --env ${this.o.name}\` first`);
    }
    this.browser = await chromium.launch({ headless: this.o.headless ?? true });
    this.context = await this.browser.newContext({ ...(this.o.statePath ? { storageState: this.o.statePath } : {}), viewport: { width: 1280, height: 860 } });
    this.page = await this.context.newPage();
    await this.page.exposeBinding('__imuiSeen', (_src, tokens: string[], at: number) => {
      for (const t of tokens) this.onSeen?.(t, at);
    });
    await this.page.goto(this.o.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return this.page;
  }

  private composer(page: Page) {
    return page.locator(this.o.inputSelector ?? COMPOSER).filter({ visible: true }).last();
  }

  async listConversations(): Promise<string[]> {
    const page = await this.ensurePage();
    await page.waitForTimeout(4_000);
    const lines = (await page.locator('body').innerText()).split('\n').map((l) => l.trim());
    return [...new Set(lines.filter((l) => l.length > 1 && l.length < 60))].slice(0, 40);
  }

  async open(conversation: string): Promise<void> {
    const page = await this.ensurePage();
    if (/login|signin|sign-in/i.test(page.url())) throw new Error(`${this.id}: not logged in (landed on ${page.url()}); run imui login again`);
    await page.getByText(conversation, { exact: true }).first().click({ timeout: 30_000 });
    await this.composer(page).waitFor({ state: 'visible', timeout: 30_000 });
  }

  async send(text: string): Promise<number> {
    const page = await this.ensurePage();
    const box = this.composer(page);
    await box.click();
    await page.keyboard.insertText(text);
    const at = Date.now();
    await page.keyboard.press('Enter');
    return at;
  }

  startWatch(runId: string, onSeen: SeenHandler): void {
    this.runId = runId;
    this.onSeen = onSeen;
    const page = this.page;
    if (!page) throw new Error(`${this.id}: open() first`);
    // Injected as a string: tsx/esbuild would otherwise insert `__name(...)` helpers that do not
    // exist in the page.
    void page.evaluate(`(() => {
      // Only text that STARTS with a token: replies quoting a token are not our messages.
      const re = new RegExp('^(imui-${runId}-[0-9]+)(?![A-Za-z0-9_-])');
      const seen = new Set();
      const leafTexts = (node) => {
        if (node.nodeType === 3) return [node.textContent];
        if (node.nodeType !== 1) return [];
        const out = [];
        const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) out.push(w.currentNode.textContent);
        return out;
      };
      const scan = (node) => {
        const found = leafTexts(node).map((t) => (re.exec((t || '').trim()) || [])[1]).filter(Boolean);
        if (!found.length) return;
        const fresh = found.filter((t) => !seen.has(t));
        if (!fresh.length) return;
        for (const t of fresh) seen.add(t);
        window.__imuiSeen(fresh, Date.now());
      };
      scan(document.body);
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'characterData') scan(r.target);
          for (const n of r.addedNodes) scan(n);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__imuiObs = obs;
    })()`);
  }

  async stopWatch(): Promise<void> {
    await this.page?.evaluate('window.__imuiObs && window.__imuiObs.disconnect()').catch(() => {});
    this.onSeen = undefined;
  }

  async duplicates(runId: string): Promise<number> {
    if (!this.page) return 0;
    const texts = (await this.page.evaluate(`(() => {
      const re = new RegExp('^imui-${runId}-[0-9]+(?![A-Za-z0-9_-])');
      // Text nodes that START with a token = one per rendered bubble (quotes in replies excluded).
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) if (re.test((w.currentNode.textContent || '').trim())) out.push(w.currentNode.textContent.trim());
      return out;
    })()`)) as string[];
    const counts = new Map<string, number>();
    for (const t of texts.map((x) => leadingToken(x, runId)).filter((x): x is string => !!x)) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);
  }

  async close(): Promise<void> {
    await this.stopWatch();
    await this.browser?.close().catch(() => {});
  }
}

/** Interactive login: headed browser; the state file is refreshed every 2 s until the window closes. */
export async function interactiveLogin(appUrl: string, statePath: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(statePath), { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto(appUrl);
  console.log(`[imui] log in in the opened window, open the chat list, then close the window. State → ${statePath}`);
  let open = true;
  browser.on('disconnected', () => (open = false));
  page.on('close', () => (open = false));
  while (open) {
    try {
      await writeFile(statePath, JSON.stringify(await context.storageState()));
    } catch {
      /* closing */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  await browser.close().catch(() => {});
}
