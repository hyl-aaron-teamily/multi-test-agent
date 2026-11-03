// Surface adapters: everything one execution surface does differently while entering the app, getting
// back to the home list or leaving a conversation. Callers (executor, sync, replay, smoke) never branch
// on the surface themselves.
import { AndroidDriver } from '../drivers/android';
import { decodePng, pixelDiff, type Rgba } from '../core/image';
import { type Driver, type Point, sleep } from '../drivers/types';
import { notifyPromptClose } from '../drivers/web-dialogs';
import { ensureUiLogin } from './login/ui-login';
import type { Surface } from '../platform/accounts/types';
import { hasElement, pointFor, type Profile } from '../skills/profile';
import { visionAsk } from '../core/model/midscene';
import { waitForRegion } from './checks';
import { pageStd } from './detect';
import type { Session } from './session';
import { visionLocator } from './plan/targets';

export interface SurfaceAdapter {
  /** Before the first launch (e.g. start a stuck browser fresh). */
  beforeLaunch?(s: Session): Promise<void>;
  /** Wait until the first screen after launch is usable. */
  waitFirstScreen(s: Session): Promise<void>;
  /** Dismiss dialogs that appear on load (only when they are visibly there). */
  dismissDialogs(s: Session): Promise<void>;
  /** Sign in by coordinates when the surface keeps its own sign-in (phone browser). */
  ensureLogin(s: Session): Promise<void>;
  /** SKILL check failed on attempt `i`: try to get back to the home list; false = give up. */
  recoverHome(s: Session, i: number): Promise<boolean>;
  /** Make sure the chat tab of the home screen is the one showing. */
  showChatTab(s: Session): Promise<void>;
  /** Leave the open conversation for the list, like a user (never leaves the app). */
  leaveConversation(d: Driver, p: Profile): Promise<void>;
  /** Is the conversation list showing? (default: the home/nav reference region) */
  atHomeList?(s: Session): Promise<boolean>;
}

const webAdapter: SurfaceAdapter = {
  // At least the old fixed 8 s, then until the home list is drawn (slow loads show a skeleton list).
  async waitFirstScreen(s) {
    await sleep(8000);
    await waitForRegion(s.d, s.profile, ['home/nav'], 30_000);
  },
  async dismissDialogs(s) {
    await dismissBanner(s);
    // "开启通知" toast covers the header (back arrow / avatar taps do nothing): close it as a user would.
    const p = s.web?.page ? await notifyPromptClose(s.web.page) : undefined;
    if (p) {
      s.log('notification prompt over the header — closing it');
      await s.d.tap(p);
      await sleep(800);
    }
  },
  async ensureLogin() {},
  async recoverHome() {
    return false;
  },
  async showChatTab() {},
  async leaveConversation(d, p) {
    if (await hasElement(p, 'chat.back')) await d.tap(await pointFor(p, 'chat.back'));
    else await d.back();
  },
};

const androidAppAdapter: SurfaceAdapter = {
  // A cold start shows a splash first: wait (≤ 20 s) until the home list or a restored chat is drawn, so the
  // SKILL check never judges the splash (and never presses Back on it — that leaves the app).
  async waitFirstScreen(s) {
    await waitForRegion(s.d, s.profile, ['home/nav', 'chat/composer'], 20_000, 1000);
  },
  async dismissDialogs() {},
  async ensureLogin() {},
  // The app restores its last screen: Back (at most 3 times, never past the home screen). Not in front any
  // more (Back left it, or something else took the screen): launch it again instead of pressing Back.
  async recoverHome(s, i) {
    if (i >= 3) return false;
    const a = s.inner as AndroidDriver;
    if (!a.foreground || !(await a.processAlive())) {
      s.log('app not in front — launching it again');
      await s.d.launch();
      await waitForRegion(s.d, s.profile, ['home/nav', 'chat/composer'], 20_000, 1000);
      return true;
    }
    await s.d.back();
    await sleep(1500);
    return true;
  },
  async showChatTab(s) {
    if (!(await hasElement(s.profile, 'nav.chat'))) return;
    await s.d.tap(await pointFor(s.profile, 'nav.chat'));
    await sleep(1500);
  },
  async leaveConversation(d) {
    await d.back();
  },
};

const androidWebAdapter: SurfaceAdapter = {
  // The phone browser can sit on "连接中…" (no connection, sending disabled) until it is restarted: start it
  // cold, as a user would after closing it.
  async beforeLaunch(s) {
    const a = s.inner as AndroidDriver;
    await a.killApp().catch(() => {});
  },
  // The phone browser loads slowly: wait for the list, a restored conversation or the login form.
  async waitFirstScreen(s) {
    await waitForRegion(s.d, s.profile, ['home/nav', 'chat/composer', 'login/form'], 45_000);
  },
  async dismissDialogs(s) {
    await dismissBanner(s);
    await awaitConnected(s);
    // The browser restores the tab as it was (a profile panel open, a conversation): start from a known page,
    // so nothing left over is taken for the home screen (2026-11-03). Signed out → the login form comes first.
    if (!(await s.profile.resolver?.refresh('login.email', { rulesOnly: true }).catch(() => false))) await toChatListAndroidWeb(s.d, s.inner as AndroidDriver, s.profile, s.log);
  },
  async ensureLogin(s) {
    await s.d.redacted(() => ensureUiLogin(s.d, s.profile, s.pool!, s.account, s.log));
  },
  async recoverHome(s, i) {
    if (i >= 2) return false;
    await toChatListAndroidWeb(s.d, s.inner as AndroidDriver, s.profile, s.log);
    return true;
  },
  showChatTab: androidAppAdapter.showChatTab,
  // System Back closes the tab: use the conversation's own back arrow.
  async leaveConversation(d, p) {
    await d.tap(await pointFor(p, 'chat.back'));
  },
  // The bottom bar (home/nav) looks the same on every page here: ask the screen.
  async atHomeList(s) {
    return (await visionAsk(s.inner as any, CHAT_LIST, 'prep').catch(() => null)) === true;
  },
};

const CHAT_LIST = 'The conversation list of the chat app is shown (a search box at the top and rows of conversations with avatars, titles and last messages); no single conversation is open';

export function adapterFor(surface: Surface): SurfaceAdapter {
  return surface === 'android-app' ? androidAppAdapter : surface === 'android-web' ? androidWebAdapter : webAdapter;
}

/** Mobile web shows a "download the app" dialog on some loads: dismiss it only if it is visibly there. */
async function dismissBanner(s: Session): Promise<void> {
  // Rules only: its "忽略" button is on screen now (never a vision guess here).
  if (!(await s.profile.resolver?.refresh('popup.appBannerDismiss', { rulesOnly: true }).catch(() => false))) return;
  s.log('app download banner visible — dismissing');
  await s.d.tap(await pointFor(s.profile, 'popup.appBannerDismiss'));
  await sleep(1500);
}

/** android-web: Teamily web reopens the last conversation on load, and that conversation's back arrow
 *  does nothing (it goes back in an empty history). The user's way out: another page (Artifacts), then
 *  聊天, then the back arrow — which now has an in-app page to return to. */
export async function toChatListAndroidWeb(d: Driver, a: AndroidDriver, profile: Profile, log: (s: string) => void): Promise<boolean> {
  log('android-web: not on the chat list (last conversation restored?) — Artifacts → 聊天 → back');
  await a.openUrl('/artifacts');
  // The phone browser can show an empty page for many seconds while the app loads (2026-11-03 evening: >10 s);
  // asking the screen before anything is painted only says "no".
  if (!(await untilPainted(d, 45_000))) log('android-web: the page stayed empty for 45 s');
  if (!(await waitPastDialog(d, a, profile, ['artifacts/nav', 'home/nav'], 40_000, log))) return false;
  // The phone browser's page answers a tap seconds later, and its bottom bar looks the same on Artifacts and
  // on the chat list: after each tap wait until the page really changed, then let the screen (vision) say
  // where we are (2026-11-03: conversations were picked from the Artifacts cards).
  const LIST = CHAT_LIST;
  const OPEN = 'A single chat conversation is open (a header with a back arrow and the conversation title at the top, messages, and a message input box at the bottom)';
  const tapAndSettle = async (p: Point) => {
    const before = decodePng(await d.screenshot());
    await d.tap(p);
    await untilChanged(d, before, 20_000);
  };
  await tapAndSettle(await pointFor(profile, 'nav.chat'));
  for (let i = 0; i < 2; i++) {
    if ((await visionAsk(a as any, LIST, 'prep').catch(() => null)) === true) return true;
    if ((await visionAsk(a as any, OPEN, 'prep').catch(() => null)) !== true) break;
    await tapAndSettle(await pointFor(profile, 'chat.back'));
  }
  const ok = (await visionAsk(a as any, LIST, 'prep').catch(() => null)) === true;
  if (!ok) log('android-web: the chat list did not show');
  return ok;
}

/** Wait until the page area shows something (not one flat colour), polled every second. */
async function untilPainted(d: Driver, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pageStd(decodePng(await d.screenshot())) >= PAINTED_STD) return true;
    await sleep(1000);
  }
  return false;
}
/** Luminance spread above which a page has content (a flat loading page is ~1). */
const PAINTED_STD = 8;

/** Wait until the page area differs from `before` (≥ 3 % of its pixels) and then holds still for one poll. */
async function untilChanged(d: Driver, before: Rgba, ms: number): Promise<boolean> {
  const t0 = Date.now();
  const area = (img: Rgba): [number, number, number, number] => [0, Math.round(img.height * 0.12), img.width, Math.round(img.height * 0.8)];
  let last: Rgba | undefined;
  while (Date.now() - t0 < ms) {
    await sleep(1000);
    const now = decodePng(await d.screenshot());
    const changed = pixelDiff(now, before, area(now)) > now.width * now.height * 0.03;
    if (changed && last && pixelDiff(now, last, area(now)) < now.width * now.height * 0.01) return true;
    last = changed ? now : undefined;
  }
  return false;
}

/** Wait for a reference region; Teamily web shows a "download the app" dialog on some page loads, which
 *  dims the page: dismiss it (its located button, or — preparation only — the vision model locates
 *  "忽略") and keep waiting. */
async function waitPastDialog(d: Driver, a: AndroidDriver, profile: Profile, keys: string[], ms: number, log: (s: string) => void): Promise<string | undefined> {
  const banner = ['banner/dismiss'];
  const t0 = Date.now();
  for (let tries = 0; tries < 3; tries++) {
    const hit = await waitForRegion(d, profile, [...keys, ...banner], Math.max(5000, ms - (Date.now() - t0)) / (tries ? 2 : 1));
    if (hit && hit !== 'banner/dismiss') return hit;
    let p: Point | null = hit ? await pointFor(profile, 'popup.appBannerDismiss') : null;
    // No region matched: tap "忽略" only when the screen really shows that dialog (2026-11-03: a vision guess
    // tapped the page when there was no dialog).
    if (!p && (await visionAsk(a as any, 'A dialog asking to download the Teamily mobile app (with an "忽略" / Ignore button) is shown over the page', 'prep').catch(() => null)) === true)
      p = (await (await visionLocator(a as any))?.('the "忽略" (Ignore) button of the dialog asking to download the Teamily mobile app')) ?? null;
    if (!p) return undefined;
    log('android-web: app download dialog over the page — dismissing');
    await d.tap(p);
  }
  return undefined;
}

/** Phone browser: the page header can stay on "连接中…" (no live connection: nothing is received and sends
 *  stay pending). Its accessibility tree is not refreshed, so the screen is asked (preparation only, ③);
 *  still connecting after ~30 s → restart the browser cold, at most twice. */
async function awaitConnected(s: Session): Promise<void> {
  const a = s.inner as AndroidDriver;
  for (let restart = 0; restart < 3; restart++) {
    for (let i = 0; i < 4; i++) {
      const connecting = await visionAsk(a as any, 'The page header shows a "连接中" (connecting) indicator with a spinner next to the title', 'prep');
      if (connecting !== true) return;
      await sleep(8000);
    }
    if (restart === 2) break;
    s.log('android-web: still "连接中…" after ~30 s — restarting the browser');
    await a.killApp().catch(() => {});
    await s.d.launch();
    await waitForRegion(s.d, s.profile, ['home/nav', 'chat/composer', 'login/form'], 45_000);
  }
  s.log('android-web: page still not connected — continuing (sync / sends may fail)');
}
