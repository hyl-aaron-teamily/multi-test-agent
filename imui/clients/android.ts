// Android UI client: no model calls on the hot path.
//   open   : warm-launch the app, tap the conversation row found in the accessibility tree
//   send   : tap the EditText, `input text`, tap the send button (located once, then cached)
//   watch  : poll `uiautomator dump` and report tokens found in text / content-desc attributes
// Polling is the resolution limit (one dump ≈ 1–3 s on the test phone); it is measured and reported,
// and each sighting is timestamped at the middle of the dump window.
import { AndroidDevice } from '@midscene/android';
import { adb, launchApp, resolveAdbPath } from '../../core/adb';
import { bubbleClusters, type Box, leadingToken } from '../tokens';
import type { SeenHandler, UiClient } from './types';

interface UiNode extends Box {
  text: string;
  /** Placeholder; an empty EditText reports its hint as `text`. */
  hint: string;
  desc: string;
  cls: string;
  clickable: boolean;
}

const attr = (n: string, k: string) => n.match(new RegExp(`\\s${k}="([^"]*)"`))?.[1] ?? '';
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Pure: uiautomator XML → nodes of `pkg`. */
export function parseNodes(xml: string, pkg: string): UiNode[] {
  const out: UiNode[] = [];
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const n = m[0];
    if (attr(n, 'package') !== pkg) continue;
    const b = attr(n, 'bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({ x1, y1, x2, y2, text: unescape(attr(n, 'text')), hint: unescape(attr(n, 'hint')), desc: unescape(attr(n, 'content-desc')), cls: attr(n, 'class'), clickable: attr(n, 'clickable') === 'true' });
  }
  return out;
}

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
  private focused = false;
  private device?: AndroidDevice;

  constructor(
    readonly udid: string,
    readonly pkg: string,
  ) {
    this.id = `android:${udid}`;
  }

  private dumpLock: Promise<unknown> = Promise.resolve();
  private dumpSeq = 0;

  /**
   * One uiautomator dump at a time per device: the watcher and the send check used to run
   * concurrently on the same file, and one could read the other's older snapshot.
   */
  dump(): Promise<{ nodes: UiNode[]; at: number }> {
    const run = this.dumpLock.then(() => this.dumpOnce(), () => this.dumpOnce());
    this.dumpLock = run.catch(() => {});
    return run;
  }

  private async dumpOnce(): Promise<{ nodes: UiNode[]; at: number }> {
    const t0 = Date.now();
    const f = `/sdcard/imui_ui_${this.dumpSeq++ % 4}.xml`;
    const xml = await adb(['shell', `rm -f ${f}; uiautomator dump ${f} >/dev/null 2>&1; cat ${f}`], this.udid, 20_000);
    const t1 = Date.now();
    this.dumpMs.push(t1 - t0);
    if (this.dumpMs.length > 50) this.dumpMs.shift();
    this.resolutionMs = Math.round(this.dumpMs.reduce((a, b) => a + b, 0) / this.dumpMs.length);
    return { nodes: parseNodes(xml, this.pkg), at: Math.round((t0 + t1) / 2) };
  }

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

  /**
   * Layout is pinned to "keyboard hidden" (the keyboard moves the composer and the send button).
   * The send button is only tapped after the composer is verified to contain this message: in this
   * app the same spot is the voice-record button when the composer is empty.
   */
  private async clearComposer(): Promise<void> {
    if (!this.device) await this.typeText(''); // creates the device
    await this.device!.ensureYadb();
    await adb(['shell', 'app_process -Djava.class.path=/data/local/tmp/yadb /data/local/tmp com.ysbing.yadb.Main -keyboardClear'], this.udid);
  }

  async send(text: string): Promise<number> {
    if (!this.input) throw new Error(`${this.id}: open() first`);
    if (!this.focused) {
      const c = center(this.input);
      await adb(['shell', 'input', 'tap', String(c.x), String(c.y)], this.udid); // focus
      await sleep(800);
      this.focused = true;
    }
    if (await this.keyboardShown()) {
      await adb(['shell', 'input', 'keyevent', '4'], this.udid); // hide keyboard, focus stays
      await sleep(600);
    }
    // yadb appends at the cursor and this RN input ignores DEL / Ctrl+A, so clear with yadb's own
    // -keyboardClear (what Midscene uses under the always-yadb IME strategy), then type and verify.
    await this.clearComposer();
    await this.typeText(text);
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
    if (!this.sendBtn) {
      // Bottom-right control below/next to the composer = send (it appears once there is text).
      const cand = nodes!
        .filter((n) => n.clickable && !/EditText/.test(n.cls) && n.y1 >= edit.y1 - 40 && n.x2 - n.x1 < 300)
        .sort((a, b) => b.x2 - a.x2 || b.y2 - a.y2);
      if (!cand.length) throw new Error('send button not found next to the composer');
      this.sendBtn = center(cand[0]);
    }
    const at = Date.now();
    await adb(['shell', 'input', 'tap', String(this.sendBtn.x), String(this.sendBtn.y)], this.udid);
    return at;
  }

  startWatch(runId: string, onSeen: SeenHandler): void {
    this.watching = true;
    const seen = new Set<string>();
    this.loop = (async () => {
      while (this.watching) {
        try {
          const { nodes, at } = await this.dump();
          // Top-to-bottom = display order, so tokens found in one poll are reported in screen order.
          const hits = nodes
            .flatMap((n) => [leadingToken(n.text, runId), leadingToken(n.desc, runId)].filter((t): t is string => !!t).map((t) => ({ t, y: n.y1 })))
            .sort((a, b) => a.y - b.y);
          for (const h of hits) if (!seen.has(h.t)) (seen.add(h.t), onSeen(h.t, at));
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
  }

  async duplicates(runId: string): Promise<number> {
    const { nodes } = await this.dump();
    const byToken = new Map<string, Box[]>();
    for (const n of nodes) {
      const t = leadingToken(n.text, runId) ?? leadingToken(n.desc, runId);
      if (t) byToken.set(t, [...(byToken.get(t) ?? []), n]);
    }
    let extra = 0;
    for (const boxes of byToken.values()) extra += Math.max(0, bubbleClusters(boxes) - 1);
    return extra;
  }

  async close(): Promise<void> {
    await this.stopWatch();
  }
}
