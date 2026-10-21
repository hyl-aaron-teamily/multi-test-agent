// Web driver (desktop-web / mobile-web) on Playwright, black-box:
//   desktop-web : page.mouse with interpolated cursor movement, wheel, keyboard; viewport 1440×900
//   mobile-web  : device emulation (Pixel 7: touch + mobile viewport), page.touchscreen.tap, CDP touch swipes
// Observation is event-only: pageerror, console error, page crash, unexpected navigation. Emulating the
// environment (viewport, device, offline) is allowed; nothing is evaluated inside the page.
import { type Browser, type BrowserContext, type CDPSession, chromium, devices, type Page } from 'playwright';
import type { Surface } from '../platform/accounts/types';
import { type Anomaly, type Driver, type Point, sleep } from './types';

export const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
export const MOBILE_DEVICE = 'Pixel 7';

export interface WebDriverOptions {
  surface: Extract<Surface, 'mobile-web' | 'desktop-web'>;
  url: string;
  storageState?: string;
  headless?: boolean;
  /** console error lines matching this are ignored (third-party noise). */
  consoleIgnore?: RegExp;
  /** Called with every console message (flight recorder). */
  onConsole?: (e: { at: number; type: string; text: string }) => void;
}

const KEYS: Record<string, string> = { enter: 'Enter', backspace: 'Backspace', escape: 'Escape', esc: 'Escape', tab: 'Tab', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: ' ' };

export function contextOptions(surface: WebDriverOptions['surface']) {
  return surface === 'mobile-web' ? { ...devices[MOBILE_DEVICE] } : { viewport: DESKTOP_VIEWPORT };
}

export class WebDriver implements Driver {
  readonly surface: WebDriverOptions['surface'];
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  private cdp?: CDPSession;
  private cursor: Point = { x: 0, y: 0 };
  private anomalies: Anomaly[] = [];
  private host = '';

  constructor(readonly o: WebDriverOptions) {
    this.surface = o.surface;
  }

  get p(): Page {
    if (!this.page) throw new Error('web driver not launched');
    return this.page;
  }

  async launch(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.o.headless ?? true });
      this.context = await this.browser.newContext({ ...contextOptions(this.surface), ...(this.o.storageState ? { storageState: this.o.storageState } : {}) });
      this.page = await this.context.newPage();
      this.watch(this.page);
      this.host = new URL(this.o.url).host;
    }
    await this.p.goto(this.o.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    this.anomalies = this.anomalies.filter((a) => a.kind !== 'url-change');
  }

  private watch(page: Page): void {
    page.on('pageerror', (e) => this.anomalies.push({ kind: 'page-error', at: Date.now(), detail: `${e.name}: ${e.message}`.slice(0, 500) }));
    page.on('crash', () => this.anomalies.push({ kind: 'page-crash', at: Date.now(), detail: 'renderer crashed' }));
    page.on('console', (m) => {
      const text = m.text();
      this.o.onConsole?.({ at: Date.now(), type: m.type(), text });
      if (m.type() === 'error' && !this.o.consoleIgnore?.test(text)) this.anomalies.push({ kind: 'console-error', at: Date.now(), detail: text.slice(0, 500), suspect: true });
    });
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      const u = new URL(f.url());
      if (u.host !== this.host || /\/login\b/.test(u.pathname)) this.anomalies.push({ kind: 'url-change', at: Date.now(), detail: f.url() });
    });
  }

  /** Cursor path: a few interpolated moves so hover/enter handlers fire like a real pointer. */
  private async moveTo(p: Point): Promise<void> {
    const d = Math.hypot(p.x - this.cursor.x, p.y - this.cursor.y);
    await this.p.mouse.move(p.x, p.y, { steps: Math.min(12, Math.max(2, Math.round(d / 80))) });
    this.cursor = p;
  }

  async tap(p: Point): Promise<void> {
    if (this.surface === 'mobile-web') await this.p.touchscreen.tap(p.x, p.y);
    else {
      await this.moveTo(p);
      await this.p.mouse.down();
      await this.p.mouse.up();
    }
  }

  async longPress(p: Point, ms = 700): Promise<void> {
    if (this.surface === 'mobile-web') {
      await this.touch('touchStart', p);
      await sleep(ms);
      await this.touch('touchEnd', p);
    } else {
      await this.moveTo(p);
      await this.p.mouse.down();
      await sleep(ms);
      await this.p.mouse.up();
    }
  }

  async type(text: string): Promise<void> {
    await this.p.keyboard.type(text, { delay: 15 });
  }

  async key(name: string): Promise<void> {
    await this.p.keyboard.press(KEYS[name.toLowerCase()] ?? name);
  }

  private async touch(type: 'touchStart' | 'touchMove' | 'touchEnd', p: Point): Promise<void> {
    this.cdp ??= await this.context!.newCDPSession(this.p);
    await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y }] });
  }

  async swipe(from: Point, to: Point, ms = 300): Promise<void> {
    if (this.surface === 'mobile-web') {
      await this.touch('touchStart', from);
      const n = 8;
      for (let i = 1; i <= n; i++) {
        await this.touch('touchMove', { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
        await sleep(ms / n);
      }
      await this.touch('touchEnd', to);
    } else {
      await this.moveTo(from);
      await this.p.mouse.down();
      await this.p.mouse.move(to.x, to.y, { steps: 8 });
      await this.p.mouse.up();
      this.cursor = to;
    }
  }

  async scroll(at: Point, dy: number): Promise<void> {
    if (this.surface === 'mobile-web') return this.swipe(at, { x: at.x, y: at.y - dy }, 250);
    await this.moveTo(at);
    await this.p.mouse.wheel(0, dy);
  }

  async back(): Promise<void> {
    await this.p.goBack({ timeout: 10_000 }).catch(() => {});
  }

  async screenshot(): Promise<Buffer> {
    return this.p.screenshot({ type: 'png' });
  }

  drainAnomalies(): Anomaly[] {
    const a = this.anomalies;
    this.anomalies = [];
    return a;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }
}
