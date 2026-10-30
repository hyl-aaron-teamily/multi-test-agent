// Isolation between runs (W2-2 §4.3) and round preconditions: a clean starting point before preparation
// (empty composer, keyboard down), a side-effect-free reset at the end (empty composer, keyboard down, home
// list), the ① read of a round's own precondition (`require` steps), drift recovery, and the epilogue.
// Never deletes or recalls a message (E4).
import { RoundDrift, sleep } from '../drivers/types';
import type { PlannedAction } from '../platform/schema/test-plan';
import { actionLabel } from './actions';
import { waitForRegion } from './checks';
import type { RunCtx } from './context';
import { composerText, observeText } from './observe';
import { onChat, redoSetup } from './prepare';
import { addTier } from './stats';
import { expandCheck } from './template';

const clearNode: PlannedAction = { type: 'node', node: { name: 'teamily.clearComposer', input: {} }, delayAfterMs: 300 };

/** A `require` step: read the round's precondition now (①). Unmet / unreadable → RoundDrift (not an attempt). */
export async function requireNow(c: RunCtx, a: PlannedAction): Promise<void> {
  const want = a.requires?.composerHas;
  if (want === undefined) return;
  const t0 = Date.now();
  const t = await c.sess.d.observe('composer', () => composerText(c.sess.inner));
  addTier((c.stats.observeTiers ??= {}), '① composer (round precondition)', Date.now() - t0);
  if (t === null) throw new RoundDrift('round precondition: composer not readable');
  if (!t.includes(want)) throw new RoundDrift(`round precondition not met: composer is "${t.slice(0, 60)}", not containing "${want}"`);
}

/** Keyboard down (App: Back only while it is up — Back with it down would leave the chat). */
async function keyboardDown(c: RunCtx): Promise<boolean> {
  const d = c.sess.d;
  if ((await d.keyboardShown()) !== true) return false;
  d.label = 'isolation:hide-keyboard';
  await d.back();
  await sleep(400);
  return true;
}

/** Clean start, after the conversation is open (App): an old draft in the composer is cleared and the
 *  keyboard put down, so nothing from an earlier run is in the way. Returns what was done. */
export async function cleanStart(c: RunCtx): Promise<string[]> {
  if (c.plan.surface !== 'android-app' || !(await onChat(c))) return [];
  const did: string[] = [];
  const t = await composerText(c.sess.inner);
  if (t) {
    c.sess.d.label = 'isolation:clear-draft';
    await c.exec(clearNode);
    did.push(`清空输入框里的旧草稿「${t.slice(0, 40).replace(/\s+/g, ' ')}${t.length > 40 ? '…' : ''}」`);
  }
  if (await keyboardDown(c)) did.push('收起键盘');
  if (did.length) c.log(`clean start: ${did.join('；')}`);
  return did;
}

/** Recover from a drifted round: re-enter the plan's start only when the chat page is gone (re-running the
 *  setup on the chat page would tap a conversation-list point inside the chat). */
export async function recoverAfterDrift(c: RunCtx): Promise<void> {
  if (await onChat(c)) return;
  // Re-entry taps frozen targets again: checked first (between rounds, never inside one).
  await (c.guard ? c.guard.during('re-entry', () => redoSetup(c)) : redoSetup(c));
}

/** Once after the loop (record only; never a hit): e.g. the conversation-list preview of the last message. */
export async function runEpilogue(c: RunCtx): Promise<void> {
  const ep = c.plan.epilogue;
  if (!ep) return;
  const { d } = c.sess;
  for (const a of ep.actions) {
    d.label = `epilogue:${actionLabel(a)}`;
    await c.exec(a);
  }
  const k = expandCheck(ep.check, { token: c.res.runTag ?? '', round: d.round });
  const r = await observeText(c.sess.inner, k, c.targets, c.sess.profile.viewport.width);
  c.res.epilogue = { expect: k.expect, pass: r.pass, detail: r.detail };
  c.log(`epilogue: ${r.pass === null ? '未验证' : r.pass ? 'as expected' : 'NOT as expected'} — ${r.detail}`);
}

/** Side-effect-free reset at the end of a run (App): empty composer, keyboard down, back on the home list. */
export async function teardown(c: RunCtx): Promise<string[]> {
  if (c.plan.surface !== 'android-app') return [];
  const did: string[] = [];
  const { d, profile } = c.sess;
  if (await onChat(c)) {
    const t = await composerText(c.sess.inner);
    if (t) {
      d.label = 'teardown:clear';
      await c.exec(clearNode);
      did.push('清空输入框');
    }
    if (await keyboardDown(c)) did.push('收起键盘');
    if (profile.elements['chat.back']) {
      d.label = 'teardown:back';
      await c.exec({ type: 'tap', element: 'chat.back', delayAfterMs: 800 });
      did.push('回到首页');
    }
  }
  if (profile.refs.home && !(await waitForRegion(d, profile, ['home/nav'], 4000, 800))) did.push('（首页未确认）');
  c.log(`teardown: ${did.join('；') || 'nothing to reset'}`);
  return did;
}
