// Web calibration (desktop-web / mobile-web). Runs at calibration time only — the one place where the
// page structure is read (Playwright locators) to find fixed elements. Output: profile coordinates,
// reference screenshots + region hashes, and an automatic self-check per element (tap → screenshot →
// expected visible change). Failed self-checks go to the review queue with an annotated image.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { type Box, decodePng, dHash, drawBox, encodePng, hamming, meanGrey, pixelDiff, scaleBox } from '../core/image';
import { WebDriver, contextOptions } from '../drivers/web';
import type { Credentials, Env } from '../platform/accounts/types';
import { type ElementCal, type Profile, SKILL_DIR, saveProfile } from './profile';
import { ELEMENTS, SKILL_VERSION } from './teamily/vocab';

type WebSurface = 'desktop-web' | 'mobile-web';

export interface CalibrateWebOptions {
  surface: WebSurface;
  env: Env;
  url: string;
  credentials: Credentials;
  headless?: boolean;
  log?: (s: string) => void;
  /** Where the logged-in storageState is written (session cache). */
  sessionFile: string;
}

const box = async (l: Locator): Promise<Box | undefined> => {
  const b = await l.boundingBox().catch(() => null);
  return b && b.width > 0 ? [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] : undefined;
};

const first = async (page: Page, ...sels: string[]): Promise<Locator | undefined> => {
  for (const s of sels) {
    const l = page.locator(s).filter({ visible: true }).first();
    if (await l.count().catch(() => 0)) return l;
  }
  return undefined;
};

export async function calibrateWeb(o: CalibrateWebOptions): Promise<Profile> {
  const log = o.log ?? ((s) => console.log(`[calibrate] ${s}`));
  const name = `${o.surface}@${o.env}`;
  const d = new WebDriver({ surface: o.surface, url: o.url, headless: o.headless });
  const vp = o.surface === 'mobile-web' ? (contextOptions('mobile-web') as any).viewport : (contextOptions('desktop-web') as any).viewport;
  const dpr = o.surface === 'mobile-web' ? ((contextOptions('mobile-web') as any).deviceScaleFactor ?? 1) : 1;
  const prof: Profile = { surface: o.surface, name, skillVersion: SKILL_VERSION, env: o.env, calibratedAt: new Date().toISOString(), viewport: vp, device: o.surface === 'mobile-web' ? 'Pixel 7' : undefined, elements: {}, refs: {}, reviewQueue: [] };
  const refDir = join(SKILL_DIR, 'refs', name);
  await mkdir(refDir, { recursive: true });
  const shot = async () => decodePng(await d.screenshot());

  const put = (id: string, b: Box | undefined, note?: string) => {
    const spec = ELEMENTS.find((e) => e.id === id)!;
    if (!b) {
      log(`  ✗ ${id}: not found`);
      prof.reviewQueue.push({ element: id, image: '', reason: 'not found during calibration' });
      return;
    }
    prof.elements[id] = { page: spec.page, box: b, selfCheck: 'pending', note } satisfies ElementCal;
    log(`  · ${id} ${JSON.stringify(b)}`);
  };

  /** Tap the element and judge the visible change. Restores nothing; callers order checks accordingly. */
  const selfCheck = async (id: string, verify?: () => Promise<boolean>) => {
    const e = prof.elements[id];
    if (!e) return;
    const spec = ELEMENTS.find((x) => x.id === id)!;
    const before = await shot();
    const url0 = d.p.url();
    await d.tap({ x: e.box[0] + e.box[2] / 2, y: e.box[1] + e.box[3] / 2 });
    // Focus probe: an input that took focus shows a typed character (works even if it was autofocused).
    if (spec.selfCheck === 'focus') await d.type('aaaa');
    await d.p.waitForTimeout(spec.selfCheck === 'navigate' ? 2500 : 900);
    const after = await shot();
    if (spec.selfCheck === 'focus') for (let i = 0; i < 4; i++) await d.key('Backspace');
    const near = scaleBox([e.box[0] - 6, e.box[1] - 6, e.box[2] + 12, e.box[3] + 12], dpr);
    const fullDiff = hamming(dHash(before), dHash(after)) + Math.abs(meanGrey(before) - meanGrey(after));
    let ok: boolean;
    let note: string;
    if (verify) {
      ok = await verify();
      note = ok ? 'expected state reached' : 'expected state not reached';
    } else if (spec.selfCheck === 'navigate') {
      ok = d.p.url() !== url0 || fullDiff >= 6;
      note = `url ${d.p.url() !== url0 ? 'changed' : 'same'}, screen Δ${fullDiff.toFixed(0)}`;
    } else if (spec.selfCheck === 'focus') {
      const px = pixelDiff(before, after, near);
      ok = px >= 15;
      note = `focus probe: ${px} px changed in element`;
    } else if (spec.selfCheck === 'popup') {
      ok = fullDiff >= 3;
      note = `screen Δ${fullDiff.toFixed(0)}`;
    } else {
      ok = true;
      note = 'no self-check (covered by flow)';
    }
    e.selfCheck = ok ? 'pass' : 'fail';
    e.note = note;
    log(`  ${ok ? '✓' : '✗'} self-check ${id}: ${note}`);
    if (!ok) {
      const img = after;
      drawBox(img, scaleBox(e.box, dpr));
      const f = join(refDir, `review-${id}.png`);
      await writeFile(f, encodePng(img));
      prof.reviewQueue.push({ element: id, image: f.slice(SKILL_DIR.length + 1).replace(/\\/g, '/'), reason: note });
    }
  };

  const ref = async (page: string, regions: Record<string, Box | undefined>) => {
    const buf = await d.screenshot();
    const img = decodePng(buf);
    const file = join(refDir, `${page}.png`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, buf);
    const r: Profile['refs'][string] = { image: `refs/${name}/${page}.png`, regions: {}, hashes: {}, greys: {} };
    for (const [k, b] of Object.entries(regions)) {
      if (!b) continue;
      const px = scaleBox(b, dpr);
      r.regions[k] = b;
      r.hashes[k] = dHash(img, px);
      r.greys[k] = Math.round(meanGrey(img, px));
    }
    prof.refs[page] = r;
    log(`  ▣ ref ${page} (${Object.keys(r.regions).join(', ') || 'full'})`);
  };

  try {
    await d.launch();
    const p = d.p;
    await p.waitForTimeout(5000);
    // ---- login page
    log(`login page ${p.url()}`);
    put('login.email', await box((await first(p, 'input[type=email]'))!));
    put('login.emailContinue', await box(p.locator('button[type=submit]').filter({ hasText: /email|邮箱/i }).first()));
    await ref('login', { form: prof.elements['login.email']?.box });
    await selfCheck('login.email');
    await d.type(o.credentials.email);
    await selfCheck('login.emailContinue');
    await p.locator('input[type=password]').waitFor({ timeout: 15_000 });
    put('login.password', await box(p.locator('input[type=password]').first()));
    put('login.continue', await box(p.locator('button[type=submit]').filter({ hasText: /^\s*(continue|继续)\s*$/i }).first()));
    await selfCheck('login.password');
    await d.type(o.credentials.password);
    await selfCheck('login.continue', async () => {
      await p.waitForURL(/\/chat/, { timeout: 30_000 }).catch(() => {});
      return /\/chat/.test(p.url());
    });
    if (!/\/chat/.test(p.url())) throw new Error(`login did not reach /chat (at ${p.url()})`);
    await p.waitForTimeout(12_000);
    await mkdir(dirname(o.sessionFile), { recursive: true });
    await d.context!.storageState({ path: o.sessionFile });

    // ---- home
    if (o.surface === 'mobile-web') {
      const dismiss = await first(p, 'div[role=dialog] button:has-text("忽略")', 'div[role=dialog] button:has-text("Ignore")');
      if (dismiss) {
        put('popup.appBannerDismiss', await box(dismiss));
        await ref('banner', { dismiss: prof.elements['popup.appBannerDismiss']?.box });
        await selfCheck('popup.appBannerDismiss');
      }
    }
    const label = (l: string) => `[aria-label="${l}"]`;
    // Nav entries carry badge counts in their label ("我, 1"), so match the prefix.
    const navLabel = (l: string) => `[aria-label="${l}"], [aria-label^="${l},"]`;
    const navChat = o.surface === 'mobile-web' ? await first(p, 'a:has-text("聊天")') : await first(p, `button:is(${navLabel('聊天')})`, `a:is(${navLabel('聊天')})`);
    const navArt = o.surface === 'mobile-web' ? await first(p, 'a:has-text("Artifacts")') : await first(p, `button:is(${navLabel('Artifacts')})`, `a:is(${navLabel('Artifacts')})`);
    const navMe = await first(p, `button:is(${navLabel('我')})`, `a:is(${navLabel('我')})`);
    put('nav.chat', navChat && (await box(navChat)));
    put('nav.artifacts', navArt && (await box(navArt)));
    put('nav.me', navMe && (await box(navMe)));
    const search = await first(p, 'input[placeholder="搜索"]', 'input[placeholder*="Search"]');
    put('chatlist.search', search && (await box(search)));
    const navRegion: Box = o.surface === 'mobile-web' ? [0, vp.height - 70, vp.width, 70] : [0, 80, 70, 360];
    await ref('home', { nav: navRegion });
    await selfCheck('chatlist.search');
    await d.key('Escape');
    if (o.surface === 'mobile-web') {
      // Mobile search opens its own screen; reload the list.
      await p.goto(o.url, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(8000);
      const again = await first(p, 'div[role=dialog] button:has-text("忽略")');
      if (again) await again.click();
    }

    // ---- chat: open a group (calibration-time only: a row whose name lists several members)
    // Conversation rows = row-sized clickables in the list column; prefer a group (name lists members).
    const listX = o.surface === 'mobile-web' ? [0, vp.width] : [70, 420];
    const cands: { b: Box; t: string }[] = [];
    for (const l of await p.locator('div[role=button], a, div.cursor-pointer').filter({ visible: true }).all()) {
      const b = await box(l);
      if (b && b[0] >= listX[0] && b[0] + b[2] <= listX[1] && b[3] >= 56 && b[3] <= 96) cands.push({ b, t: (await l.innerText().catch(() => '')).split('\n')[0] });
    }
    const pick = cands.find((c) => c.t.includes(',')) ?? cands[0];
    if (!pick) throw new Error('no conversation row visible for chat-page calibration');
    log(`  conversation for chat-page calibration: ${pick.t.includes(',') ? 'group' : 'first row (no group in this account)'}`);
    const gb = pick.b;
    await d.tap({ x: gb[0] + gb[2] / 2, y: gb[1] + gb[3] / 2 });
    await p.waitForTimeout(4000);
    const composer = p.locator('[contenteditable="true"]').filter({ visible: true }).last();
    put('chat.composer', await box(composer));
    if (o.surface === 'mobile-web') {
      const back = await first(p, `button${label('返回')}`, `button${label('Back')}`, 'header button');
      put('chat.back', back && (await box(back)));
    }
    await ref('chat', { composer: prof.elements['chat.composer']?.box });
    await selfCheck('chat.composer');
    await d.type('@');
    await p.waitForTimeout(1500);
    const pickerHead = p.getByText('所有人', { exact: true }).filter({ visible: true }).first();
    const ph = await box(pickerHead);
    const picker = ph ? await box(p.locator('div').filter({ has: pickerHead }).filter({ hasText: /成员|Members/ }).last()) : undefined;
    // The stable part of the picker: its header row (所有人 / 所有人类 / 所有智能体), full picker width.
    const pickerRegion: Box | undefined = ph && picker ? [picker[0], ph[1] - 6, Math.min(picker[2], vp.width - picker[0]), ph[3] + 12] : undefined;
    await ref('mention-picker', { picker: pickerRegion });
    if (!pickerRegion) prof.reviewQueue.push({ element: 'region:mention-picker/picker', image: `refs/${name}/mention-picker.png`, reason: 'picker did not open after typing @' });
    await d.key('Escape');
    await d.key('Backspace');
    await d.type('x');
    await p.waitForTimeout(500);
    const send = await first(p, `button${label('发送')}`, `button${label('Send')}`);
    put('chat.send', send && (await box(send)));
    await d.key('Backspace');
    if (o.surface === 'mobile-web' && prof.elements['chat.back']) await selfCheck('chat.back');

    // ---- profile page (bell)
    await selfCheck('nav.me');
    await p.waitForTimeout(3000);
    const pbell = await first(p, `button${label('通知')}`, `button${label('Notifications')}`);
    put('profile.bell', pbell && (await box(pbell)));
    await ref('profile', { bell: prof.elements['profile.bell']?.box && pad(prof.elements['profile.bell'].box, 6) });
    await selfCheck('profile.bell');
    await d.key('Escape');
    // ---- artifacts page (bell)
    await p.goBack().catch(() => {});
    await p.waitForTimeout(2500);
    if (o.surface === 'mobile-web' && !(await first(p, 'a:has-text("Artifacts")'))) await p.goto(o.url, { waitUntil: 'domcontentloaded' }).then(() => p.waitForTimeout(6000));
    await selfCheck('nav.artifacts');
    await p.waitForTimeout(3000);
    const abell = await first(p, `button${label('通知')}`, `button${label('Notifications')}`);
    put('artifacts.bell', abell && (await box(abell)));
    await ref('artifacts', { bell: prof.elements['artifacts.bell']?.box && pad(prof.elements['artifacts.bell'].box, 6) });
    await selfCheck('artifacts.bell');
    await d.key('Escape');
    // ---- CloudDoc (desktop): first card of the grid opens a document in a new tab
    if (o.surface === 'desktop-web') {
      // First card slot of the grid: a large labelled button in the content area (geometry, calibration-time only).
      await p.waitForTimeout(3000);
      let cardBox: Box | undefined;
      for (const l of await p.locator('button[aria-label]').filter({ visible: true }).all()) {
        const b = await box(l);
        if (b && b[0] > 320 && b[2] > 200 && b[3] > 150 && (!cardBox || b[1] < cardBox[1] || (b[1] === cardBox[1] && b[0] < cardBox[0]))) cardBox = b;
      }
      put('artifacts.firstCard', cardBox);
      if (prof.elements['artifacts.firstCard']) {
        const e = prof.elements['artifacts.firstCard'];
        await d.tap({ x: e.box[0] + e.box[2] / 2, y: e.box[1] + e.box[3] / 2 });
        await p.waitForTimeout(9000);
        const opened = d.p !== p;
        e.selfCheck = opened ? 'pass' : 'fail';
        e.note = opened ? `opened ${new URL(d.p.url()).pathname.split('/')[1]} in a new tab` : 'no new tab';
        log(`  ${opened ? '✓' : '✗'} self-check artifacts.firstCard: ${e.note}`);
        if (opened) {
          const dp = d.p;
          // The doc header bell sits between Help and the avatar; its accessible name is 权限申请 / 通知.
          const bell = await first(dp, `button${label('通知')}`, `button${label('权限申请')}`, `button${label('Notifications')}`);
          put('clouddoc.bell', bell && (await box(bell)));
          await ref('clouddoc', { bell: prof.elements['clouddoc.bell']?.box && pad(prof.elements['clouddoc.bell'].box, 6) });
          await selfCheck('clouddoc.bell');
          await d.key('Escape');
          await d.back();
          await p.waitForTimeout(1500);
        }
      }
    }
    // nav.chat last (navigates back home)
    await selfCheck('nav.chat');
  } finally {
    await d.close();
  }
  const f = await saveProfile(prof);
  const fails = Object.entries(prof.elements).filter(([, e]) => e.selfCheck === 'fail').length;
  log(`profile → ${f}  (${Object.keys(prof.elements).length} elements, ${fails} self-check failures, review queue ${prof.reviewQueue.length})`);
  return prof;
}

const pad = (b: Box, n: number): Box => [b[0] - n, b[1] - n, b[2] + 2 * n, b[3] + 2 * n];
