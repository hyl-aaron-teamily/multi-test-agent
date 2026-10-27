// Teamily SKILL Nodes (table: node-specs.ts). Nodes of phase "any" only perform coordinate operations
// through a black-box Driver (coordinates from the surface profile and the targets frozen at preparation);
// "prepare-only" Nodes may also locate (hierarchy / vision) and never run in the loop.
import { z } from 'zod';
import type { Driver, Point } from '../../drivers/types';
import { sleep } from '../../drivers/types';
import { type Credentials, mobileLayout } from '../../platform/accounts/types';
import { decodePng, pixelDiff } from '../../core/image';
import { pointOf, type Profile } from '../profile';
import { NODE_SPECS } from './node-specs';

export interface NodeContext {
  driver: Driver;
  profile: Profile;
  /** Frozen dynamic targets: id → point. */
  targets: Record<string, Point>;
  /** Resolved by the executor from the account pool; never logged. */
  credentials?: () => Credentials;
  /** Max wait used by nodes that wait for a page (ms). */
  settleMs?: number;
  /** Tiered locate (prepare-only Nodes): literal texts first, then the description by vision. */
  /** textOnly: ① literal text only — never a vision guess (where a wrong guess would tap something else). */
  locate?: (description: string, texts: string[], newest?: boolean, textOnly?: boolean) => Promise<Point | null>;
}

type Exec<I> = (ctx: { input: I; context: NodeContext }) => Promise<{ summary?: string } | void>;

// Node input schemas: our zod copy in node-specs.ts (@midscene/core validates against its own zod, so the
// schemas are used for `autotest nodes` and plan validation instead of `inputSchema`).
export const NODE_SCHEMAS = Object.fromEntries(NODE_SPECS.map((n) => [n.name, n.schema])) as Record<string, z.ZodObject<any>>;

export type NodeName = string;

const target = (c: NodeContext, id: string): Point => {
  const p = c.targets[id];
  if (!p) throw new Error(`target ${id} not frozen (preparation stage did not pick it)`);
  return p;
};

const tapEl = (c: NodeContext, id: string) => c.driver.tap(pointOf(c.profile, id));
const pointBox = (c: NodeContext, id: string) => {
  const e = c.profile.elements[id];
  if (!e) throw new Error(`element ${id} not calibrated in profile ${c.profile.name}`);
  return e.box;
};

const login: Exec<{ account?: string }> = async ({ context: c }) => {
  const cred = c.credentials?.();
  if (!cred) throw new Error('teamily.login: no credentials provider');
  // Phone browser: the on-screen keyboard covers the form buttons — submit with its Enter ("Go") key.
  const submit = (id: string) => (c.driver.surface === 'android-web' ? c.driver.key('enter') : tapEl(c, id));
  await tapEl(c, 'login.email');
  await c.driver.type(cred.email);
  await submit('login.emailContinue');
  await sleep(Math.max(c.settleMs ?? 0, 3500));
  await tapEl(c, 'login.password');
  await c.driver.type(cred.password);
  await submit('login.continue');
  return { summary: `login ${cred.email.replace(/^(.).*@/, '$1***@')}` };
};

const openConversation: Exec<{ target: string }> = async ({ input, context: c }) => {
  await c.driver.tap(target(c, input.target));
  return { summary: `open ${input.target}` };
};

const sendMessage: Exec<{ text: string; kind?: 'plain' | 'markdown-link' }> = async ({ input: raw, context: c }) => {
  // markdown-link: the text goes out in Markdown link syntax [text](text) (precondition of the 2044 family).
  const input = raw.kind === 'markdown-link' ? { ...raw, text: `[${raw.text}](${raw.text})` } : raw;
  // Screen checks (no hierarchy reads): the keyboard really came up before Back hides it, and the composer
  // box looks empty again after sending — otherwise send once more with the send button.
  const box = pointBox(c, 'chat.composer');
  const shot = async () => decodePng(await c.driver.screenshot());
  const empty = await shot();
  await tapEl(c, 'chat.composer');
  await sleep(500);
  let focused = await shot();
  // Phones: type only once the soft keyboard is up — text typed with nothing focused lands elsewhere
  // (the phone browser puts it into its address bar). One retap, then give up (a drift, not a send).
  if (mobileLayout(c.driver.surface) && c.driver.surface !== 'mobile-web') {
    const up = async () => {
      for (let i = 0; i < 6; i++) {
        // System state when available (screen changes from new messages fooled the pixel test).
        const kb = c.driver.keyboardShown ? await c.driver.keyboardShown() : null;
        if (kb === true || (kb === null && pixelDiff(empty, focused) > 20_000)) return true;
        await sleep(500);
        focused = await shot();
      }
      return false;
    };
    if (!(await up())) {
      await tapEl(c, 'chat.composer');
      if (!(await up())) throw new Error('teamily.sendMessage: the composer did not take focus (keyboard not up) — not typing');
    }
  }
  await c.driver.type(input.text);
  if (c.driver.surface === 'android-app') {
    // RN composer: Enter is a newline. Hide the keyboard (only if it is up: Back would otherwise leave the
    // conversation), then tap the (calibrated, keyboard-down) send button.
    const kbUp = c.driver.keyboardShown ? await c.driver.keyboardShown() : null;
    if (kbUp === true || (kbUp === null && pixelDiff(empty, focused) > 20_000)) {
      await c.driver.back();
      await sleep(400);
    }
    await tapEl(c, 'chat.send');
  } else if (mobileLayout(c.driver.surface)) await tapEl(c, 'chat.send'); // touch keyboard: Enter is a newline (phone browser: send calibrated with the keyboard up)
  else await c.driver.key('Enter');
  await sleep(800);
  if (!mobileLayout(c.driver.surface)) {
    // Desktop: text still in the composer (Enter swallowed while the conversation was still loading) → send button.
    const after = await shot();
    const dpr = after.width / c.profile.viewport.width;
    // Baseline: the focused, still-empty composer (no placeholder difference).
    const px = pixelDiff(focused, after, [box[0] * dpr, box[1] * dpr, box[2] * dpr, box[3] * dpr]);
    if (px > 150 && c.profile.elements['chat.send']) {
      await tapEl(c, 'chat.send');
      await sleep(800);
      return { summary: `sent ${input.text.length} chars (Enter did not send; used the send button)` };
    }
  }
  return { summary: `sent ${input.text.length} chars` };
};

/** prepare-only: quote-reply a message found by its text — long-press it, choose 引用/回复 in its menu,
 *  type the reply, send. Locating (accessibility first, vision after) happens here, never in the loop. */
const quoteReply: Exec<{ quote: string; text: string }> = async ({ input, context: c }) => {
  if (!c.locate) throw new Error('teamily.quoteReply: no locator (prepare-only node)');
  // The message just sent may still be rendering: look a few times.
  let msg: Point | null = null;
  for (let i = 0; i < 4 && !msg; i++) {
    if (i) await sleep(1500);
    msg = await c.locate(`the message bubble containing "${input.quote}" (the newest one)`, [input.quote], true);
  }
  if (!msg) throw new Error(`teamily.quoteReply: message "${input.quote}" not on screen`);
  // The menu item must really be the message menu's: on the App it is read from the accessibility tree only
  // (a vision guess once picked a composer-toolbar icon and opened the meeting-minutes sheet). One retry.
  const textOnly = c.driver.surface === 'android-app';
  let item: Point | null = null;
  for (let i = 0; i < 2 && !item; i++) {
    if (i) await c.driver.back().then(() => sleep(800));
    await c.driver.longPress(msg);
    await sleep(1500);
    item = await c.locate('the Quote / Reply item of the message action menu', ['引用', '回复', 'Quote', 'Reply'], false, textOnly);
  }
  if (!item) throw new Error('teamily.quoteReply: the message menu (引用 / 回复) did not open');
  await c.driver.tap(item);
  await sleep(1000);
  await sendMessage({ input: { text: input.text }, context: c });
  return { summary: `quote-replied to "${input.quote.slice(0, 30)}"` };
};

const typeMention: Exec<Record<string, never>> = async ({ context: c }) => {
  await tapEl(c, 'chat.composer');
  await c.driver.type('@');
};

const clearComposer: Exec<Record<string, never>> = async ({ context: c }) => {
  await c.driver.key('Escape');
  await tapEl(c, 'chat.composer');
  for (let i = 0; i < 3; i++) await c.driver.key('Backspace');
};

const switchConversation: Exec<{ from: string; to: string }> = async ({ input, context: c }) => {
  if (mobileLayout(c.driver.surface)) await tapEl(c, 'chat.back').catch(() => {});
  await c.driver.tap(target(c, input.to));
  await sleep(c.settleMs ?? 500);
  if (mobileLayout(c.driver.surface)) await tapEl(c, 'chat.back').catch(() => {});
  await c.driver.tap(target(c, input.from));
};

const openPage: Exec<{ page: 'profile' | 'artifacts' | 'chat' }> = async ({ input, context: c }) => {
  const before = decodePng(await c.driver.screenshot());
  await tapEl(c, input.page === 'profile' ? 'nav.me' : input.page === 'artifacts' ? 'nav.artifacts' : 'nav.chat');
  await sleep(c.settleMs ?? 1500);
  // A slow page: judging "absent" on the page we came from would be wrong — wait (≤ 10 s) until it changed.
  if (input.page !== 'chat')
    for (let i = 0; i < 10; i++) {
      const now = decodePng(await c.driver.screenshot());
      if (pixelDiff(before, now) >= now.width * now.height * 0.05) break;
      if (i === 4) await tapEl(c, input.page === 'profile' ? 'nav.me' : 'nav.artifacts');
      await sleep(1000);
    }
};

const EXEC: Record<NodeName, Exec<any>> = {
  'teamily.login': login,
  'teamily.openConversation': openConversation,
  'teamily.sendMessage': sendMessage,
  'teamily.typeMention': typeMention,
  'teamily.clearComposer': clearComposer,
  'teamily.switchConversation': switchConversation,
  'teamily.openPage': openPage,
  'teamily.quoteReply': quoteReply,
};

/** Direct execution path used by the executor (same code as the Midscene node). */
export async function runNode(name: string, input: Record<string, unknown>, context: NodeContext): Promise<string | undefined> {
  const fn = EXEC[name as NodeName];
  if (!fn) throw new Error(`unknown node ${name}`);
  const r = await fn({ input: NODE_SCHEMAS[name as NodeName].parse(input ?? {}), context });
  return r?.summary;
}

export function listNodes(): { name: string; description: string; phase: string; implemented: boolean; input: unknown }[] {
  return NODE_SPECS.map((n) => ({ name: n.name, description: n.description, phase: n.phase, implemented: !!EXEC[n.name], input: z.toJSONSchema(n.schema) }));
}
