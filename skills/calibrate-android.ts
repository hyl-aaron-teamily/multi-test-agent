// Android calibration: reads the accessibility tree (core/ui-tree). At run time the tree is read only outside the loop (preparation, round-end text checks, warm-up, self-heal) — never per step.
// Finds fixed elements, writes coordinates + reference regions into profiles/android-<udid>@<env>.json
// and self-checks every element (tap → screenshot → expected visible change).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { adb } from '../core/adb';
import { type Box, decodePng, drawBox, encodePng, pixelDiff } from '../core/image';
import { AndroidDriver } from '../drivers/android';
import { sleep } from '../drivers/types';
import { listDevices } from '../platform/adb-devices';
import type { Env } from '../platform/accounts/types';
import { dumpTree, toBox as nodeBox, type UiNode } from '../core/ui-tree';
import { queueReview, saveRef } from './calibrate-common';
import { type Profile, SKILL_DIR, saveProfile } from './profile';
import { ELEMENTS, SKILL_VERSION } from './teamily/vocab';

export interface CalibrateAndroidOptions {
  udid?: string;
  env: Env;
  packageName: string;
  log?: (s: string) => void;
}

export type N = UiNode;
export const toBox = (n: N): Box => nodeBox(n);

/** Calibration read of the accessibility tree (core/ui-tree: locked, retried, timed). */
export const dump = (udid: string, pkg: string): Promise<N[]> => dumpTree(udid, pkg);

export async function calibrateAndroid(o: CalibrateAndroidOptions): Promise<Profile> {
  const log = o.log ?? ((s) => console.log(`[calibrate] ${s}`));
  const udid = o.udid ?? (await listDevices()).find((d) => d.state === 'device')?.udid;
  if (!udid) throw new Error('no adb device online');
  const size = (await adb(['shell', 'wm', 'size'], udid)).match(/(\d+)x(\d+)/);
  const name = `android-${udid}@${o.env}`;
  const prof: Profile = { surface: 'android-app', name, skillVersion: SKILL_VERSION, env: o.env, calibratedAt: new Date().toISOString(), viewport: { width: Number(size?.[1] ?? 1080), height: Number(size?.[2] ?? 2400) }, packageName: o.packageName, elements: {}, refs: {}, reviewQueue: [] };
  const refDir = join(SKILL_DIR, 'refs', name);
  await mkdir(refDir, { recursive: true });
  const d = new AndroidDriver({ udid, packageName: o.packageName });
  const shot = async () => decodePng(await d.screenshot());

  const put = (id: string, n: N | undefined) => {
    const spec = ELEMENTS.find((e) => e.id === id)!;
    if (!n) {
      log(`  ✗ ${id}: not found`);
      queueReview(prof, id, 'not found during calibration');
      return;
    }
    prof.elements[id] = { page: spec.page, box: toBox(n), selfCheck: 'pending', ...(n.text || n.desc ? { fingerprint: { text: n.text || undefined, desc: n.desc || undefined, cls: n.cls } } : {}) };
    log(`  · ${id} ${JSON.stringify(toBox(n))}`);
  };
  const selfCheck = async (id: string, minPx = 2000) => {
    const e = prof.elements[id];
    if (!e) return;
    const before = await shot();
    await d.tap({ x: e.box[0] + e.box[2] / 2, y: e.box[1] + e.box[3] / 2 });
    await sleep(1500);
    const after = await shot();
    const px = pixelDiff(before, after);
    const ok = px >= minPx;
    e.selfCheck = ok ? 'pass' : 'fail';
    e.note = `screen Δ${px}px`;
    log(`  ${ok ? '✓' : '✗'} self-check ${id}: ${e.note}`);
    if (!ok) {
      drawBox(after, e.box);
      const f = join(refDir, `review-${id}.png`);
      await writeFile(f, encodePng(after));
      prof.reviewQueue.push({ element: id, image: `refs/${name}/review-${id}.png`, reason: e.note });
    }
  };
  const ref = async (page: string, regions: Record<string, Box | undefined>) => saveRef(prof, page, await d.screenshot(), regions, 1, log);

  try {
    await d.launch();
    await sleep(3000);
    let nodes = await dump(udid, o.packageName);
    // Back out to the home screen (the app restores the last screen).
    for (let i = 0; i < 4 && !nodes.some((n) => n.desc === '聊天' && /Button/.test(n.cls)); i++) {
      await d.back();
      await sleep(1500);
      nodes = await dump(udid, o.packageName);
      if (!nodes.length) {
        await d.launch();
        await sleep(3000);
        nodes = await dump(udid, o.packageName);
      }
    }
    const byDesc = (re: RegExp, cls = /Button|ViewGroup/) => nodes.find((n) => n.clickable && re.test(n.desc) && cls.test(n.cls));
    put('nav.chat', byDesc(/^聊天$/));
    put('nav.me', byDesc(/^我的$/));
    put('chatlist.search', byDesc(/^搜索$/));
    const navNode = byDesc(/^聊天$/);
    await ref('home', { nav: navNode ? [0, navNode.y1, prof.viewport.width, navNode.y2 - navNode.y1] : undefined });
    await selfCheck('chatlist.search');
    await d.back();
    await sleep(1500);
    // group row: a clickable row whose title lists several members
    nodes = await dump(udid, o.packageName);
    const title = nodes.find((n) => !n.clickable && /,/.test(n.text) && n.y1 > 300 && n.y2 < prof.viewport.height - 300);
    const row = title && nodes.find((n) => n.clickable && n.x1 <= title.x1 && n.x2 >= title.x2 && n.y1 <= title.y1 && n.y2 >= title.y2 && n.y2 - n.y1 < 400);
    if (!row) throw new Error('no group conversation row on the home screen');
    log(`  conversation for chat-page calibration: group`);
    await d.tap({ x: (row.x1 + row.x2) / 2, y: (row.y1 + row.y2) / 2 });
    await sleep(3000);
    nodes = await dump(udid, o.packageName);
    put('chat.back', byDesc(/^返回$/));
    const composer = nodes.find((n) => /EditText/.test(n.cls));
    put('chat.composer', composer);
    // AI rewrite (W2-2, Issue 2010): the sparkle button of the composer toolbar, keyboard down.
    put('chat.rewrite', byDesc(/^((用记忆)?强化 ?prompt|改写|AI 改写|Rewrite|Enhance prompt( with memory)?)$/i, /Button|ViewGroup/));
    // Chat-page marker: the composer's toolbar row (+ / Instant / icons) — stable, unlike the input's text.
    await ref('chat', { composer: composer && [0, composer.y2, prof.viewport.width, 150] });
    await selfCheck('chat.composer', 20_000); // keyboard comes up
    await d.type('@');
    await sleep(2000);
    nodes = await dump(udid, o.packageName);
    let all = nodes.find((n) => n.desc === '所有人' && n.clickable);
    if (!all) {
      log(`  picker not seen yet (${nodes.length} nodes), retyping @`);
      await d.key('backspace');
      await d.type('@');
      await sleep(2500);
      nodes = await dump(udid, o.packageName);
      all = nodes.find((n) => n.desc === '所有人' && n.clickable);
    }
    await ref('mention-picker', { picker: all ? [0, all.y1, prof.viewport.width, all.y2 - all.y1] : undefined });
    if (!all) prof.reviewQueue.push({ element: 'region:mention-picker/picker', image: `refs/${name}/mention-picker.png`, reason: 'picker did not open after typing @' });
    await d.back();
    await sleep(800);
    await d.key('backspace');
    // A space sends it through yadb: the phone's IME can eat plain `input text`.
    await d.type('autotest calibrate');
    await sleep(800);
    nodes = await dump(udid, o.packageName);
    // The send button has no label: the right-most button on the composer's toolbar row (keyboard up).
    const comp2 = nodes.find((n) => /EditText/.test(n.cls));
    put(
      'chat.send',
      byDesc(/^(发送|Send)$/) ??
        (comp2 ? nodes.filter((n) => n.clickable && /Button/.test(n.cls) && !n.desc && n.x1 > prof.viewport.width * 0.75 && n.y1 >= comp2.y2 - 20 && n.y1 < comp2.y2 + 250).sort((a, b) => b.x2 - a.x2)[0] : undefined),
    );
    // Rewrite confirmation (Teamily 2.0.20 asks "用记忆强化 prompt?" before rewriting): tap rewrite with the
    // draft still in, keyboard down; a dialog with 取消 → its button and reference region. Older versions
    // rewrite at once (no dialog, nothing recorded).
    // Keyboard down (Back only while it is up: with it down Back leaves the chat).
    const hideKb = async () => {
      if ((await d.keyboardShown()) === true) {
        await d.back();
        await sleep(800);
      }
    };
    await hideKb();
    // The dialog needs a draft: retype once if it did not land.
    const draft = async () => (await dump(udid, o.packageName)).find((n) => /EditText/.test(n.cls))?.text ?? '';
    if (comp2 && !(await draft())) {
      await d.tap({ x: (comp2.x1 + comp2.x2) / 2, y: (comp2.y1 + comp2.y2) / 2 });
      await sleep(800);
      await d.type('autotest calibrate');
      await sleep(800);
      await hideKb();
    }
    const rw = prof.elements['chat.rewrite'];
    if (rw && !(await draft())) {
      log('  composer still empty — rewrite confirmation not checked');
      queueReview(prof, 'chat.rewriteCancel', 'composer empty (typed text lost), rewrite confirmation not checked');
    }
    else if (rw) {
      await d.tap({ x: rw.box[0] + rw.box[2] / 2, y: rw.box[1] + rw.box[3] / 2 });
      await sleep(2000);
      nodes = await dump(udid, o.packageName);
      const label = (n: N) => n.text || n.desc;
      const cancel = nodes.find((n) => /^(取消|Cancel)$/i.test(label(n)));
      const confirm = nodes.find((n) => n !== cancel && /^(强化|确定|确认|OK|Confirm|Enhance)$/i.test(label(n)) && cancel && Math.abs(n.y1 - cancel.y1) < 60);
      if (cancel && confirm) {
        // The dialog: the smallest node holding both buttons and a title above them.
        const box = nodes
          .filter((n) => n.x1 <= cancel.x1 && n.x2 >= confirm.x2 && n.y2 >= cancel.y2 && n.y1 < cancel.y1 - 100 && n.x2 - n.x1 < prof.viewport.width)
          .sort((a, b) => (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1))[0];
        put('chat.rewriteCancel', cancel);
        log(`  rewrite confirmation dialog seen (${nodes.filter((n) => /\?$|？$/.test(label(n))).map(label)[0] ?? 'no title'})`);
        await ref('rewrite-confirm', { dialog: box ? toBox(box) : [Math.min(cancel.x1, confirm.x1) - 40, cancel.y1 - 360, Math.max(cancel.x2, confirm.x2) - Math.min(cancel.x1, confirm.x1) + 80, cancel.y2 - cancel.y1 + 400] });
        await d.tap({ x: (cancel.x1 + cancel.x2) / 2, y: (cancel.y1 + cancel.y2) / 2 });
        await sleep(1200);
      } else {
        log('  no rewrite confirmation dialog (rewrite runs at once on this version)');
        await sleep(6000); // let the rewrite finish before clearing
      }
    }
    if (comp2) {
      await d.tap({ x: (comp2.x1 + comp2.x2) / 2, y: (comp2.y1 + comp2.y2) / 2 });
      await sleep(800);
    }
    await d.key('selectAll');
    await d.key('backspace');
    await hideKb();
    await selfCheck('chat.back');
    await sleep(1500);
    await selfCheck('nav.me');
    await d.back();
    await sleep(1200);
    await selfCheck('nav.chat', 1);
  } finally {
    await d.close();
  }
  const f = await saveProfile(prof);
  log(`profile → ${f}  (${Object.keys(prof.elements).length} elements, ${Object.values(prof.elements).filter((e) => e.selfCheck === 'fail').length} self-check failures, review queue ${prof.reviewQueue.length})`);
  return prof;
}
