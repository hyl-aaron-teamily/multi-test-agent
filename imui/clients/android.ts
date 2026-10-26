// Android UI client: no model calls on the hot path.
//   open   : warm-launch the app, tap the conversation row found in the accessibility tree
//   send   : focus the composer once, clear + type via yadb (IME-proof), read the composer back,
//            then tap the send button (located once with the keyboard hidden, then cached)
//   watch  : poll `uiautomator dump` and report tokens found in text / content-desc attributes
// Polling is the resolution limit (one dump ≈ 1–3 s on the test phone); it is measured and reported,
// and each sighting is timestamped at the middle of the dump window.
import { AndroidDevice } from '@midscene/android';
import { adb, launchApp, resolveAdbPath } from '../../core/adb';
import { parseNodes, readUiXml, type UiNode } from '../../core/ui-tree';
import { bubbleClusters, type Box, leadingToken } from '../tokens';
import type { SeenHandler, UiClient } from './types';

export { parseNodes };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const center = (b: Box) => ({ x: Math.round((b.x1 + b.x2) / 2), y: Math.round((b.y1 + b.y2) / 2) });

export class AndroidClient implements UiClient {
  readonly kind = 'android' as const;
  readonly id: string;
  resolutionMs = 0;
  private input?: Box;
  private sendBtn?: { x: number; y: number };
  private watching = false;
  private loop?: Promise<void>;
  private dumpMs: number[] = [];
  private device?: AndroidDevice;

  constructor(
    readonly udid: string,
    readonly pkg: string,
  ) {
    this.id = `android:${udid}`;
  }

  /** Serialised per device in core/ui-tree (the watcher and the send check share one device). */
  dump(): Promise<{ nodes: UiNode[]; at: number }> {
    return this.dumpOnce();
  }

  private async dumpOnce(): Promise<{ nodes: UiNode[]; at: number }> {
    const { xml, t0, t1 } = await readUiXml(this.udid);
    this.dumpMs.push(t1 - t0);
    if (this.dumpMs.length > 50) this.dumpMs.shift();
    this.resolutionMs = Math.round(this.dumpMs.reduce((a, b) => a + b, 0) / this.dumpMs.length);
    const nodes = parseNodes(xml, this.pkg);
    const at = Math.round((t0 + t1) / 2);
    // Every dump (also the ones taken by send()) feeds the watcher: more samples, finer resolution.
    if (process.env.IMUI_DEBUG) console.log(`[imui:debug] ${this.id} dump ${t0 % 100000}→${t1 % 100000} (${t1 - t0}ms) nodes=${nodes.length}`);
    this.observe?.(nodes, at);
    return { nodes, at };
  }

  private observe?: (nodes: UiNode[], at: number) => void;

  async listConversations(): Promise<string[]> {
    await launchApp(this.pkg, this.udid);
    await sleep(3_000);
    let { nodes } = await this.dump();
    // The app may resume inside a chat: back out until there is no composer.
    for (let i = 0; i < 3 && nodes.some((n) => /EditText/.test(n.cls)); i++) {
      await adb(['shell', 'input', 'keyevent', '4'], this.udid);
      await sleep(1_500);
      ({ nodes } = await this.dump());
    }
    // Conversation titles are the first text of each tappable row; keep distinct, readable ones.
    return [...new Set(nodes.filter((n) => n.text && n.text.length > 1 && !/^\d{1,2}[:/]\d{2}/.test(n.text)).map((n) => n.text))].slice(0, 40);
  }

  async open(conversation: string): Promise<void> {
    await launchApp(this.pkg, this.udid);
    await sleep(3_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { nodes } = await this.dump();
      const edit = nodes.find((n) => /EditText/.test(n.cls));
      // Already inside the right conversation?
      if (edit && nodes.some((n) => n.text === conversation && n.y2 < 400)) {
        this.input = edit;
        return;
      }
      const row = nodes.find((n) => n.text === conversation && n.y1 > 250);
      if (row) {
        const c = center(row);
        await adb(['shell', 'input', 'tap', String(c.x), String(c.y)], this.udid);
        await sleep(2_500);
        const after = await this.dump();
        const e = after.nodes.find((n) => /EditText/.test(n.cls));
        if (e) {
          this.input = e;
          return;
        }
      } else {
        await adb(['shell', 'input', 'keyevent', '4'], this.udid); // maybe inside another chat
        await sleep(1_500);
      }
    }
    throw new Error(`${this.id}: conversation "${conversation}" not found on screen (open it once manually or check the name with \`imui discover\`)`);
  }

  /** Text entry through Midscene's yadb helper: bypasses the IME (a Chinese keyboard turns
   *  `adb input text` letters into pinyin candidates). No model is involved. */
  private async typeText(text: string): Promise<void> {
    if (!this.device) {
      const adbPath = resolveAdbPath();
      this.device = new AndroidDevice(this.udid, adbPath === 'adb' ? {} : { androidAdbPath: adbPath });
    }
    if (text) await this.device.execYadb(text);
  }

  private async keyboardShown(): Promise<boolean> {
    const out = await adb(['shell', 'dumpsys', 'input_method'], this.udid).catch(() => '');
    return /mInputShown=true/.test(out);
  }

  /** Dump with retries: uiautomator refuses while the UI animates ("could not get idle state"). */
  private async dumpRetry(tries = 4): Promise<UiNode[] | undefined> {
    for (let i = 0; i < tries; i++) {
      try {
        const { nodes } = await this.dump();
        if (nodes.length) return nodes;
      } catch {
        this.idleFailures++;
      }
      await sleep(700);
    }
    return undefined;
  }

  idleFailures = 0;

  private async clearComposer(): Promise<void> {
    if (!this.device) await this.typeText(''); // creates the device
    await this.device!.ensureYadb();
    await adb(['shell', 'app_process -Djava.class.path=/data/local/tmp/yadb /data/local/tmp com.ysbing.yadb.Main -keyboardClear'], this.udid);
  }

  /**
   * Type with the keyboard UP (the RN input is focused), then hide it before tapping: with the
   * keyboard up the IME window overlays the app and covers the computed send position (one run
   * opened the IME clipboard panel instead). The send button is located from the same dump that
   * verifies the composer, and only tapped once the composer holds this message — in this app the
   * same spot is the voice-record button when the composer is empty.
   */
  async send(text: string, onPress?: (at: number) => void): Promise<number> {
    if (!this.input) throw new Error(`${this.id}: open() first`);
    // Focus the composer at its CURRENT position: it shrinks back to one line after a long message
    // is sent, so an old centre can land on a chat bubble instead.
    for (let i = 0; i < 2 && !(await this.keyboardShown()); i++) {
      const now: UiNode | Box = (await this.dumpRetry())?.find((n) => /EditText/.test(n.cls)) ?? this.input;
      this.input = now;
      const c = center(now);
      await adb(['shell', 'input', 'tap', String(c.x), String(c.y)], this.udid);
      await sleep(900);
    }
    // yadb pastes at the cursor and this RN input ignores DEL / Ctrl+A: clear with yadb's own
    // -keyboardClear (what Midscene uses under the always-yadb IME strategy), then type.
    await this.clearComposer();
    await this.typeText(text);
    if (await this.keyboardShown()) {
      await adb(['shell', 'input', 'keyevent', '4'], this.udid); // hide keyboard; text stays
      await sleep(700);
    }
    const head = text.slice(0, 24);
    let nodes: UiNode[] | undefined;
    let edit: UiNode | undefined;
    for (let i = 0; i < 3; i++) {
      await sleep(800);
      nodes = await this.dumpRetry();
      edit = nodes?.find((n) => /EditText/.test(n.cls));
      if (edit?.text.trim().startsWith(head)) break;
    }
    if (!edit || !edit.text.trim().startsWith(head)) {
      throw new Error(`composer check failed (${!nodes ? 'UI never idle' : `composer has "${(edit?.text ?? '').slice(0, 24)}"`}); not tapping send`);
    }
    this.input = edit;
    // Send = right-most control in the toolbar row BELOW the composer text. Multi-line text adds an
    // "expand editor" icon at the composer's top-right, which must not be mistaken for send.
    const cand = nodes!
      // Only the toolbar row hugging the composer's bottom edge: panels (emoji/stickers) open
      // further below, and the expand icon sits inside the text area above edit.y2.
      .filter((n) => n.clickable && !/EditText/.test(n.cls) && n.x2 - n.x1 < 300 && n.y1 >= edit.y2 - 20 && n.y1 <= edit.y2 + 150)
      .sort((a, b) => b.x2 - a.x2);
    if (!cand.length) throw new Error('send button not found next to the composer');
    this.sendBtn = center(cand[0]);
    const at = Date.now();
    onPress?.(at);
    await adb(['shell', 'input', 'tap', String(this.sendBtn.x), String(this.sendBtn.y)], this.udid);
    // A real send empties the composer. If our text is still there, the tap hit something else:
    // stop here rather than tapping around (and forget the cached position).
    await sleep(600);
    const after = (await this.dumpRetry(2))?.find((n) => /EditText/.test(n.cls));
    if (after && after.text !== after.hint && after.text.trim().startsWith(head)) {
      this.sendBtn = undefined;
      throw new Error('send tap did not take (composer still holds the message)');
    }
    return at;
  }

  startWatch(runId: string, onSeen: SeenHandler): void {
    this.watching = true;
    const seen = new Set<string>();
    this.observe = (nodes, at) => {
      // The composer holds the message before it is sent: never count it as a bubble.
      // Top-to-bottom = display order, so tokens found in one dump are reported in screen order.
      const hits = nodes
        .filter((n) => !/EditText/.test(n.cls))
        .flatMap((n) => [leadingToken(n.text, runId), leadingToken(n.desc, runId)].filter((t): t is string => !!t).map((t) => ({ t, y: n.y1 })))
        .sort((a, b) => a.y - b.y);
      for (const h of hits) if (!seen.has(h.t)) (seen.add(h.t), onSeen(h.t, at));
    };
    this.loop = (async () => {
      while (this.watching) {
        try {
          await this.dump();
        } catch {
          this.idleFailures++; // usually "could not get idle state" while the UI animates
          await sleep(500);
        }
      }
    })();
  }

  async stopWatch(): Promise<void> {
    this.watching = false;
    await this.loop;
    this.observe = undefined;
  }

  async duplicates(runId: string): Promise<number> {
    const { nodes } = await this.dump();
    const byToken = new Map<string, UiNode[]>();
    for (const n of nodes) {
      if (/EditText/.test(n.cls)) continue;
      const t = leadingToken(n.text, runId) ?? leadingToken(n.desc, runId);
      if (t) byToken.set(t, [...(byToken.get(t) ?? []), n]);
    }
    let extra = 0;
    for (const ns of byToken.values()) {
      // One TextView per rendered bubble; wrapper Views can report bounds that do not overlap it
      // (seen for bubbles partly scrolled off the top), so count TextViews when there are any.
      const tv = ns.filter((n) => /TextView/.test(n.cls));
      extra += Math.max(0, (tv.length ? tv.length : bubbleClusters(ns)) - 1);
    }
    return extra;
  }

  async close(): Promise<void> {
    await this.stopWatch();
  }
}
