// android-web calibration: Teamily web in the phone's own browser. Calibration time only:
//   - page structure from the phone's accessibility tree (`uiautomator dump`: the browser exposes web
//     content as nodes). The browser builds that tree when a page loads and does not follow in-page (SPA)
//     navigation, so after each in-app navigation the page is reloaded with the browser's own refresh
//     button (a user action) before it is read;
//   - what only exists transiently (the password step, the @ picker, the send button while typing) is
//     located on the screenshot by the vision model (Midscene aiLocate).
// Runs use coordinates only. Signs in the account that owns this surface (the browser keeps the session);
// the form is submitted with the keyboard's Enter, because the on-screen keyboard covers the form buttons.
import { visionLocateRect } from '../core/model/midscene';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Box, decodePng, drawBox, encodePng, pixelDiff } from '../core/image';
import { AndroidDriver } from '../drivers/android';
import { BROWSER_PACKAGE } from '../drivers/factory';
import { sleep } from '../drivers/types';
import { modelCalls } from '../core/model/llm';
import type { Credentials, Env } from '../platform/accounts/types';
import { dump, type N, toBox } from './calibrate-android';
import { queueReview, saveRef } from './calibrate-common';
import { loadProfile, type Profile, SKILL_DIR, saveProfile } from './profile';
import { ELEMENTS, SKILL_VERSION } from './teamily/vocab';

export interface CalibrateAndroidWebOptions {
  udid: string;
  env: Env;
  url: string;
  credentials: Credentials;
  packageName?: string;
  log?: (s: string) => void;
}

const label = (n: N) => n.text || n.desc || n.hint;
/** A pattern matches a node when it matches its text, description or hint. */
const has = (n: N, re: RegExp) => re.test(n.text) || re.test(n.desc) || re.test(n.hint);

export async function calibrateAndroidWeb(o: CalibrateAndroidWebOptions): Promise<Profile> {
  const log = o.log ?? ((s) => console.log(`[calibrate] ${s}`));
  const pkg = o.packageName ?? BROWSER_PACKAGE;
  const name = `android-web-${o.udid}@${o.env}`;
  const d = new AndroidDriver({ udid: o.udid, packageName: pkg, surface: 'android-web', url: o.url });
  const first = decodePng(await d.screenshot());
  const prof: Profile = { surface: 'android-web', name, skillVersion: SKILL_VERSION, env: o.env, calibratedAt: new Date().toISOString(), viewport: { width: first.width, height: first.height }, packageName: pkg, elements: {}, refs: {}, reviewQueue: [] };
  const refDir = join(SKILL_DIR, 'refs', name);
  await mkdir(refDir, { recursive: true });
  const shot = async () => decodePng(await d.screenshot());
  let nodes: N[] = [];
  const look = async () => (nodes = await dump(o.udid, pkg));
  const find = (re: RegExp, cls?: RegExp, where: (n: N) => boolean = () => true) => nodes.find((n) => has(n, re) && (!cls || cls.test(n.cls)) && where(n));
  // Web content only (below the browser's address bar, above its toolbar).
  const web = () => nodes.find((n) => /WebView$/.test(n.cls) && n.y2 - n.y1 > 800);
  const inWeb = (n: N) => {
    const w = web();
    // No WebView node (the browser did not expose the page): keep clear of its address bar and toolbar.
    if (!w) return n.y1 >= 260 && n.y2 <= prof.viewport.height - 180 && n.y2 > n.y1;
    // The browser's address bar (its hint is also 搜索…) is never page content.
    return n.y1 >= Math.max(w.y1, 250) && n.y2 <= w.y2 + 2 && n.y2 > n.y1 && !/EditText/.test(n.cls) || (n.y1 >= Math.max(w.y1, 250) && /EditText/.test(n.cls) && n.y2 <= w.y2 + 2 && !/网址|URL/i.test(n.hint));
  };
  const tapNode = (n: { x1: number; y1: number; x2: number; y2: number }) => d.tap({ x: Math.round((n.x1 + n.x2) / 2), y: Math.round((n.y1 + n.y2) / 2) });

  // ---- vision locate (Midscene, counted)
  const locate = async (q: string): Promise<N | undefined> => {
    const r = await visionLocateRect({ surface: 'android-web', o: { udid: o.udid } }, q, 'calibrate');
    if (!r) return undefined;
    return { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h, text: q, hint: '', desc: '(vision)', cls: 'vision', clickable: true };
  };

  const put = (id: string, n: N | undefined) => {
    const spec = ELEMENTS.find((e) => e.id === id)!;
    if (!n) {
      log(`  ✗ ${id}: not found`);
      queueReview(prof, id, 'not found during calibration');
      return;
    }
    prof.elements[id] = { page: spec.page, box: toBox(n), selfCheck: 'pending', note: n.cls === 'vision' ? 'located by vision' : undefined, ...(n.cls !== 'vision' && (n.text || n.desc) ? { fingerprint: { text: n.text || undefined, desc: n.desc || undefined, cls: n.cls } } : {}) };
    log(`  · ${id} ${JSON.stringify(toBox(n))} "${label(n).slice(0, 30)}"`);
  };
  const mark = (id: string, ok: boolean, note: string, img?: ReturnType<typeof decodePng>) => {
    const e = prof.elements[id];
    if (!e) return;
    e.selfCheck = ok ? 'pass' : 'fail';
    e.note = `${e.note ? `${e.note}; ` : ''}${note}`;
    log(`  ${ok ? '✓' : '✗'} self-check ${id}: ${note}`);
    if (!ok && img) {
      drawBox(img, e.box);
      void writeFile(join(refDir, `review-${id}.png`), encodePng(img));
      prof.reviewQueue.push({ element: id, image: `refs/${name}/review-${id}.png`, reason: note });
    }
  };
  /** Tap and judge by the screen change. */
  const selfCheck = async (id: string, minPx = 2000) => {
    const e = prof.elements[id];
    if (!e) return;
    const before = await shot();
    await d.tap({ x: e.box[0] + e.box[2] / 2, y: e.box[1] + e.box[3] / 2 });
    await sleep(1800);
    let after = await shot();
    let px = pixelDiff(before, after);
    if (px < minPx) {
      // Slow page: give the tap time to take effect before judging.
      await sleep(3000);
      after = await shot();
      px = pixelDiff(before, after);
    }
    mark(id, px >= minPx, `screen Δ${px}px`, after);
  };
  /** Tap an input until the keyboard is up (big screen change). */
  const focusField = async (id: string) => {
    const e = prof.elements[id];
    if (!e) throw new Error(`${id} not calibrated`);
    let px = 0;
    let after = await shot();
    for (let i = 0; i < 3 && px < 20_000; i++) {
      const before = await shot();
      await d.tap({ x: e.box[0] + e.box[2] / 2, y: e.box[1] + e.box[3] / 2 });
      await sleep(1500);
      after = await shot();
      px = pixelDiff(before, after);
    }
    mark(id, px >= 20_000, `keyboard ${px >= 20_000 ? 'up' : 'not up'} (screen Δ${px}px)`, after);
    if (px < 20_000) throw new Error(`${id}: tapping it does not bring up the keyboard`);
  };
  const ref = async (page: string, regions: Record<string, Box | undefined>) => saveRef(prof, page, await d.screenshot(), regions, 1, log);
  /** Browser prompts over the page ("set as default browser"): decline. */
  const dismissBrowserPrompts = async () => {
    await look();
    const no = nodes.find((n) => has(n, /^(取消|以后再说|Not now|Cancel)$/) && !inWeb(n));
    if (no) {
      await tapNode(no);
      await sleep(800);
      await look();
    }
  };
  /** Wait until `ok` holds on a fresh accessibility read. */
  const until = async (ok: () => boolean, ms = 40_000) => {
    let seen = 0;
    for (let t = 0; t < ms; t += 2000) {
      await look();
      // Twice in a row: a page still loading can show the condition for a moment.
      if (ok()) {
        if (++seen >= 2) return true;
      } else seen = 0;
      await sleep(2000);
    }
    return false;
  };
  /** The browser's own refresh button (native, outside the page): reloads the page, rebuilding its tree. */
  const reload = async (ok: () => boolean) => {
    await look();
    const r = nodes.find((n) => /^(刷新|Refresh|Reload)$/.test(n.desc) && !inWeb(n));
    if (r) await tapNode(r);
    else await d.launch();
    await sleep(4000);
    await dismissBrowserPrompts();
    return until(ok);
  };
  const atLogin = () => !!find(/通过邮箱继续|Continue with Email/i, /Button/, inWeb);
  const navChatNode = () => nodes.find((n) => has(n, /^(\d+ )?(聊天|Chat)$/) && inWeb(n) && n.y1 > (web()?.y2 ?? prof.viewport.height) - 320);
  // The "download the app" dialog is modal: while it is up the rest of the page is hidden from the tree.
  const appDialog = () => find(/^(忽略|Ignore)$/, /Button/, inWeb);
  // A conversation opens as a dialog over the list (the list stays in the tree underneath).
  const chatDialog = () => nodes.find((n) => /Dialog$/.test(n.cls) && inWeb(n) && n.y2 - n.y1 > 1000);
  const atHome = () => (!!navChatNode() || !!appDialog()) && !chatDialog();
  /** The header's back arrow: the first (unlabelled) button at the top-left of the conversation dialog. */
  const chatBack = () => {
    const dlg = chatDialog();
    return dlg ? nodes.find((n) => n.clickable && /Button/.test(n.cls) && n.x1 >= dlg.x1 && n.x2 < dlg.x1 + 200 && n.y1 >= dlg.y1 && n.y2 < dlg.y1 + 200) : undefined;
  };

  const atChat = () => !!chatDialog() && !!find(/^(Emoji|表情)$/, undefined, inWeb);

  try {
    await d.launch();
    await sleep(3000);
    await dismissBrowserPrompts();
    // A resumed tab keeps a stale tree: always read after a reload. Start from the chat list.
    if (!(await reload(() => atLogin() || atHome() || atChat()))) throw new Error('Teamily page did not come up in the browser');
    if (atChat()) {
      // Teamily web reopens the last conversation on load, and that conversation's back arrow does nothing
      // (it goes back in a history that is empty). Reach the list like a user would: another page, then 聊天,
      // then the conversation's back arrow (which now has somewhere to go back to).
      log('  last conversation restored on load — leaving it via Artifacts → 聊天 → back');
      await d.openUrl('/artifacts');
      if (!(await until(() => !!navChatNode()))) throw new Error('artifacts page not shown');
      await tapNode(navChatNode()!);
      await sleep(3000);
      await until(() => atChat() || atHome(), 15_000);
      if (atChat()) {
        await tapNode(chatBack() ?? (await locate('the back arrow (←) at the top-left of the chat header'))!);
        await sleep(2500);
      }
      if (!(await until(atHome, 20_000))) throw new Error('chat list not shown');
      // Closed with its back arrow, the conversation is no longer reopened on load: reload for a fresh tree.
      if (!(await reload(() => atHome() || atChat())) || atChat()) throw new Error('the last conversation is reopened on every load — cannot reach the chat list');
    }
    // ---- login
    if (atLogin()) {
      put('login.email', find(/^(邮箱|Email)/i, /EditText/, inWeb));
      put('login.emailContinue', find(/通过邮箱继续|Continue with Email/i, /Button/, inWeb));
      const em = prof.elements['login.email'];
      const bt = prof.elements['login.emailContinue'];
      await ref('login', { form: em && bt ? [Math.min(em.box[0], bt.box[0]), em.box[1], Math.max(em.box[2], bt.box[2]), bt.box[1] + bt.box[3] - em.box[1]] : undefined });
      await focusField('login.email');
      await d.type(o.credentials.email);
      await d.key('enter'); // the keyboard's Go submits the form
      await sleep(3500);
      mark('login.emailContinue', true, 'form submitted with the keyboard Enter (button kept as reference)');
      // The password step is an in-page view: locate its field on the screen.
      put('login.password', await locate('the password input box (请输入密码 / 密码), not the email box'));
      put('login.continue', await locate('the 继续 (Continue) button under the password box'));
      await focusField('login.password');
      await d.type(o.credentials.password);
      await d.key('enter');
      await sleep(5000);
      const signedIn = await reload(atHome);
      mark('login.continue', signedIn, signedIn ? 'submitted with the keyboard Enter → chat list' : 'not signed in after Enter');
      if (!signedIn) throw new Error('android-web sign-in did not reach the chat list');
    } else {
      // Signed in already: keep the login calibration of the previous profile (made on a signed-out browser).
      const prev = loadProfile(name);
      for (const [id, e] of Object.entries(prev?.elements ?? {})) if (/^(login|onboarding)\./.test(id)) prof.elements[id] = e;
      for (const page of ['login', 'onboarding']) if (prev?.refs[page]) prof.refs[page] = prev.refs[page];
      log(`already signed in (no login page) — kept ${Object.keys(prof.elements).length} login element(s) from the previous profile`);
    }
    // ---- home: "download the app" dialog, bottom navigation, search
    const ignore = appDialog();
    if (ignore) {
      put('popup.appBannerDismiss', ignore);
      await ref('banner', { dismiss: toBox(ignore) });
      await selfCheck('popup.appBannerDismiss', 3000);
      if (prof.elements['popup.appBannerDismiss']?.selfCheck === 'fail') {
        prof.reviewQueue = prof.reviewQueue.filter((r) => r.element !== 'popup.appBannerDismiss');
        await sleep(2000);
        await selfCheck('popup.appBannerDismiss', 3000);
      }
      if (!(await until(() => !!navChatNode(), 8000))) log('  page tree still hidden after the dialog closed');
    }
    const w = web();
    const bottom = (w?.y2 ?? prof.viewport.height) - 320;
    const clickableAround = (n: N | undefined) => (n ? (nodes.filter((x) => x.clickable && inWeb(x) && x.x1 <= n.x1 && x.x2 >= n.x2 && x.y1 <= n.y1 && x.y2 >= n.y2).sort((a, b) => (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1))[0] ?? n) : undefined);
    const navNode = (re: RegExp) => clickableAround(nodes.filter((n) => has(n, re) && inWeb(n) && n.y1 > bottom).sort((a, b) => b.y1 - a.y1)[0]);
    put('nav.chat', navNode(/^(聊天|Chat)$/));
    put('nav.artifacts', navNode(/^Artifacts$/i));
    // Phone layout: "我" is the avatar at the top-left, not in the bottom bar.
    put('nav.me', clickableAround(find(/^(我|Me)$/, undefined, inWeb)) ?? (await locate('the round user avatar ("我" / Me entry) at the top-left of the chat list header')));
    put('chatlist.search', clickableAround(find(/^(搜索|Search)/, undefined, inWeb)));
    const nb = prof.elements['nav.chat']?.box;
    const navBand: Box | undefined = nb && w ? [w.x1, nb[1] - 4, w.x2 - w.x1, nb[3] + 8] : undefined;
    await ref('home', { nav: navBand });
    // Artifacts: same bottom bar with another tab highlighted — the waypoint back to the list (see executor).
    if (prof.elements['nav.artifacts'] && navBand) {
      await selfCheck('nav.artifacts', 20_000);
      await sleep(4000);
      await ref('artifacts', { nav: navBand });
      await selfCheck('nav.chat', 20_000);
      await sleep(2500);
      await look();
    }
    // ---- chat page: a group row (title lists several members). The free-trial card floats over the
    // bottom of the list: close it (a user would), and scroll the list if the row is still under it.
    const close = find(/^(关闭|Close)$/, /Button/, inWeb);
    if (close && find(/免费试用|free trial/i, undefined, inWeb)) {
      await tapNode(close);
      await sleep(1200);
      await look();
    }
    const groupTitle = () => nodes.find((n) => inWeb(n) && /TextView/.test(n.cls) && /,/.test(n.text) && n.y1 > (w?.y1 ?? 0) + 150);
    // The list loads progressively (skeleton rows while "连接中…"): wait up to ~40 s for a group title.
    for (let i = 0; i < 16 && !groupTitle(); i++) {
      await sleep(2500);
      await look();
    }
    for (let i = 0; i < 3; i++) {
      const g = groupTitle();
      if (!g || g.y2 < (nb?.[1] ?? prof.viewport.height) - 200) break;
      await d.swipe({ x: Math.round(prof.viewport.width / 2), y: 1600 }, { x: Math.round(prof.viewport.width / 2), y: 1000 }, 400);
      await sleep(1200);
      await look();
    }
    const title = groupTitle();
    // The browser builds its accessibility tree at page load; rows that arrive later are only on screen:
    // let the vision model find a group row then (calibration time only).
    const row = clickableAround(title) ?? (await locate('a conversation row in the chat list whose title lists several member names separated by commas (a group chat)'));
    if (!row) throw new Error('no group conversation row on the chat list');
    log(`  conversation for chat-page calibration: "${title ? label(title).slice(0, 40) : '(vision)'}"`);
    await tapNode(row);
    await sleep(3000);
    if (!(await until(atChat, 20_000))) throw new Error('conversation did not open');
    put('chat.back', chatBack() ?? (await locate('the back arrow (←) at the top-left of the chat header')));
    const composer = nodes.filter((n) => /EditText/.test(n.cls) && inWeb(n) && !/搜索/.test(n.hint)).sort((a, b) => b.y1 - a.y1)[0];
    put('chat.composer', composer);
    const emoji = find(/^(Emoji|表情)$/, undefined, inWeb);
    await ref('chat', { composer: emoji ? [w?.x1 ?? 0, emoji.y1 - 6, (w?.x2 ?? prof.viewport.width) - (w?.x1 ?? 0), emoji.y2 - emoji.y1 + 12] : composer ? [0, composer.y2, prof.viewport.width, 120] : undefined });
    await focusField('chat.composer');
    await d.type('@');
    await sleep(2000);
    const all = await locate('the 所有人 (everyone) entry at the top of the member picker list that opened above the input box');
    await ref('mention-picker', { picker: all ? [w?.x1 ?? 0, all.y1 - 8, (w?.x2 ?? prof.viewport.width) - (w?.x1 ?? 0), all.y2 - all.y1 + 16] : undefined });
    if (!all) prof.reviewQueue.push({ element: 'region:mention-picker/picker', image: `refs/${name}/mention-picker.png`, reason: 'picker not located after typing @' });
    await d.key('backspace');
    await d.type('x');
    await sleep(1200);
    // Keyboard up (as right after typing a message): the send button is calibrated in this state.
    put('chat.send', await locate('the send button (paper plane / 发送) at the right end of the message input box'));
    mark('chat.send', !!prof.elements['chat.send'], 'located with the keyboard up; covered by the send flow');
    await d.key('backspace');
    await sleep(400);
    // Leave with the conversation's back arrow (the keyboard goes with it; system Back would close the tab).
    await selfCheck('chat.back');
    await sleep(1500);
    // Last: "我" opens the profile page (the next run starts from the address again).
    await selfCheck('nav.me');
  } finally {
    await d.close();
  }
  const f = await saveProfile(prof);
  log(`profile → ${f}  (${Object.keys(prof.elements).length} elements, ${Object.values(prof.elements).filter((e) => e.selfCheck === 'fail').length} self-check failures, review queue ${prof.reviewQueue.length}, vision calls ${modelCalls.vision})`);
  return prof;
}
