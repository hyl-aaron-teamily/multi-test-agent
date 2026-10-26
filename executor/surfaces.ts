// Surface adapters: everything one execution surface does differently while entering the app, getting
// back to the home list or leaving a conversation. Callers (executor, sync, replay, smoke) never branch
// on the surface themselves.
import { AndroidDriver } from '../drivers/android';
import { type Driver, type Point, sleep } from '../drivers/types';
import { notifyPromptClose } from '../drivers/web-dialogs';
import { ensureUiLogin } from './login/ui-login';
import type { Surface } from '../platform/accounts/types';
import { pointOf, type Profile } from '../skills/profile';
import { evaluateVisual, waitForRegion } from './checks';
import type { Session } from './session';
import { visionLocator } from './targets';

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
    if (p.elements['chat.back']) await d.tap(pointOf(p, 'chat.back'));
    else await d.back();
  },
};

const androidAppAdapter: SurfaceAdapter = {
  async waitFirstScreen() {},
  async dismissDialogs() {},
  async ensureLogin() {},
  // The app restores its last screen: Back (at most 3 times, never past the home screen).
  async recoverHome(s, i) {
    if (i >= 3) return false;
    await s.d.back();
    await sleep(1500);
    return true;
  },
  async showChatTab(s) {
    if (!s.profile.elements['nav.chat']) return;
    await s.d.tap(pointOf(s.profile, 'nav.chat'));
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
  },
  async ensureLogin(s) {
    await s.d.redacted(() => ensureUiLogin(s.d, s.profile, s.pool, s.account, s.log));
  },
  async recoverHome(s, i) {
    if (i >= 2) return false;
    await toChatListAndroidWeb(s.d, s.inner as AndroidDriver, s.profile, s.log);
    return true;
  },
  showChatTab: androidAppAdapter.showChatTab,
  // System Back closes the tab: use the conversation's own back arrow.
  async leaveConversation(d, p) {
    await d.tap(pointOf(p, 'chat.back'));
  },
};

export function adapterFor(surface: Surface): SurfaceAdapter {
  return surface === 'android-app' ? androidAppAdapter : surface === 'android-web' ? androidWebAdapter : webAdapter;
}

/** Mobile web shows a "download the app" dialog on some loads: dismiss it only if it is visibly there. */
async function dismissBanner(s: Session): Promise<void> {
  if (!s.profile.refs.banner) return;
  const banner = await evaluateVisual(s.d, s.profile, { kind: 'visual-region', page: 'banner', region: 'dismiss', expect: 'app banner shown', want: 'present' });
  if (banner.pass) {
    s.log('app download banner visible — dismissing');
    await s.d.tap(pointOf(s.profile, 'popup.appBannerDismiss'));
    await sleep(1500);
  }
}

/** android-web: Teamily web reopens the last conversation on load, and that conversation's back arrow
 *  does nothing (it goes back in an empty history). The user's way out: another page (Artifacts), then
 *  聊天, then the back arrow — which now has an in-app page to return to. */
export async function toChatListAndroidWeb(d: Driver, a: AndroidDriver, profile: Profile, log: (s: string) => void): Promise<boolean> {
  log('android-web: not on the chat list (last conversation restored?) — Artifacts → 聊天 → back');
  await a.openUrl('/artifacts');
  if (!(await waitPastDialog(d, a, profile, ['artifacts/nav', 'home/nav'], 40_000, log))) return false;
  await d.tap(pointOf(profile, 'nav.chat'));
  const where = await waitPastDialog(d, a, profile, ['chat/composer', 'home/nav'], 20_000, log);
  if (where === 'chat/composer') {
    await d.tap(pointOf(profile, 'chat.back'));
    return !!(await waitPastDialog(d, a, profile, ['home/nav'], 15_000, log));
  }
  return where === 'home/nav';
}

/** Wait for a reference region; Teamily web shows a "download the app" dialog on some page loads, which
 *  dims the page: dismiss it (its calibrated button, or — preparation only — the vision model locates
 *  "忽略") and keep waiting. */
async function waitPastDialog(d: Driver, a: AndroidDriver, profile: Profile, keys: string[], ms: number, log: (s: string) => void): Promise<string | undefined> {
  const banner = profile.refs.banner ? ['banner/dismiss'] : [];
  const t0 = Date.now();
  for (let tries = 0; tries < 3; tries++) {
    const hit = await waitForRegion(d, profile, [...keys, ...banner], Math.max(5000, ms - (Date.now() - t0)) / (tries ? 2 : 1));
    if (hit && hit !== 'banner/dismiss') return hit;
    let p: Point | null = hit ? pointOf(profile, 'popup.appBannerDismiss') : null;
    if (!p) p = (await (await visionLocator(a as any))?.('the "忽略" (Ignore) button of a dialog asking to download the Teamily mobile app')) ?? null;
    if (!p) return undefined;
    log('android-web: app download dialog over the page — dismissing');
    await d.tap(p);
  }
  return undefined;
}
