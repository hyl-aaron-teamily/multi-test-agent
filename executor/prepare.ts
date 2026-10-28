// Preparation phase: dynamic targets → setup → in-conversation targets → precondition (prepare +
// prepareCheck) → targets located after it. Runs once; may use the locate tiers and the vision model.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AndroidDriver } from '../drivers/android';
import { sleep } from '../drivers/types';
import { mobileLayout } from '../platform/accounts/types';
import { actionLabel } from './actions';
import { assertSkillFresh, evaluateAi, evaluateVisual, waitForRegion } from './checks';
import type { RunCtx } from './context';
import { isRowKind, pickTargets } from './targets';
import { observeKeyboard, observeText } from './observe';
import { constructionAllowed, loadConversations } from '../platform/conversations';

const freeze = async (c: RunCtx, phase: 'rows' | 'inside' | 'after-prepare') => {
  for (const t of await pickTargets(c.plan, c.sess.inner, c.sess.profile, c.log, c.locate, phase, c.res.targets)) {
    c.res.targets.push(t);
    c.targets[t.id] = t.point;
  }
};

/** Does the plan expect to sit in a conversation (and is the chat page calibrated)? */
const inChat = (c: RunCtx) => c.plan.setup.some((a) => a.node?.name === 'teamily.openConversation') && !!c.sess.profile.refs.chat?.regions.composer;

/** On the chat page (or the plan does not need it)? One screenshot unless `png` is given. */
export async function onChat(c: RunCtx, png?: Buffer): Promise<boolean> {
  if (!inChat(c)) return true;
  const r = await evaluateVisual(c.sess.d, c.sess.profile, { kind: 'visual-region', page: 'chat', region: 'composer', expect: 'chat page open (composer visible)', want: 'present', onlyOnAnomaly: false }, undefined, png);
  return r.pass !== false;
}

/** Re-enter the plan's starting point after an operation drift (never leaves the app). */
export async function redoSetup(c: RunCtx): Promise<void> {
  const { d, inner, profile } = c.sess;
  // Left the app (a link opened a browser): bring the app back like a user would — launch it.
  if (inner instanceof AndroidDriver && !inner.foreground) {
    c.log('app not in foreground — relaunching it');
    await d.launch();
    c.stats.launches++;
    await sleep(2000);
  }
  for (let i = 0; i < 3 && mobileLayout(c.plan.surface); i++) {
    if (await onChat(c)) break;
    // Never back out of the home screen (that would leave the app).
    if ((await assertSkillFresh(d, profile).then(() => true, () => false)) === true) break;
    await c.sess.adapter.leaveConversation(d, profile);
    await sleep(1200);
  }
  for (const a of c.plan.setup) {
    d.label = `re-setup:${actionLabel(a)}`;
    await c.exec(a);
  }
}

export async function prepare(c: RunCtx): Promise<void> {
  const { d, profile } = c.sess;
  c.res.targets = [];
  // Conversation rows are picked on the home list: a restored conversation (phone browser) or a sheet left
  // open would make the row pick tap something else — get back to the list first.
  if (c.plan.targets.some((t) => isRowKind(t.kind)) && c.sess.profile.refs.home && !(await waitForRegion(d, profile, ['home/nav'], 6000))) {
    c.log('not on the home list before picking conversations — going back to it');
    for (let i = 0; i < 2 && !(await waitForRegion(d, profile, ['home/nav'], 4000)); i++) await c.sess.adapter.recoverHome(c.sess, i);
  }
  await freeze(c, 'rows');
  for (const a of c.plan.setup) {
    d.label = actionLabel(a);
    await c.exec(a);
  }
  // Targets inside the opened conversation (message, reaction button) are decided after setup.
  await freeze(c, 'inside');
  if (inChat(c) && !(await onChat(c))) {
    c.log('not on the chat page after preparation — redoing setup');
    await redoSetup(c);
  }
  if (c.plan.prepare.length) {
    assertConstructionAllowed(c);
    for (const a of c.plan.prepare) {
      d.label = `prepare:${actionLabel(a)}`;
      await c.exec(a);
    }
    if (c.plan.prepareCheck) {
      const k = c.plan.prepareCheck;
      const pc = k.kind === 'ai' ? await evaluateAi(k, c.ask) : k.kind === 'text' ? await observeText(c.sess.inner, k, c.targets, profile.viewport.width) : k.kind === 'keyboard' ? await observeKeyboard(c.sess.inner, k) : await evaluateVisual(d, profile, k, c.ask);
      await writeFile(join(c.o.runDir, 'prepare-check.png'), await d.screenshot());
      c.log(`precondition: ${pc.pass ? 'established' : 'NOT established'} — ${pc.detail}`);
      if (!pc.pass) throw new Error(`前置条件未建立（${c.plan.prepareCheck.expect}）— ${pc.detail}；见 prepare-check.png`);
    }
    await freeze(c, 'after-prepare');
  }
  c.setupOps = d.ops.filter((x) => x.op !== 'launch');
}

/** Prepare steps that post into a conversation (send / quote-reply) construct data: only in a conversation
 *  of the private allow list (members are all pool accounts / the user — W2-1 D5). */
export function assertConstructionAllowed(c: RunCtx): void {
  const posts = c.plan.prepare.some((a) => a.node?.name === 'teamily.sendMessage' || a.node?.name === 'teamily.quoteReply');
  if (!posts || c.plan.issueRef === 'smoke') return;
  const conv = c.res.targets.find((t) => ROW_KINDS_FOR_CONSTRUCT.has(t.kind));
  const allow = loadConversations().construct.allow;
  if (!conv || !constructionAllowed(conv.chosen, allow)) throw new Error(`前置条件需构造，但没有允许的会话（选中 "${conv?.chosen ?? '-'}"；允许清单 platform/conversations.local.yaml 有 ${allow.length} 个）`);
  c.log(`construction allowed in "${conv.chosen}" (allow list)`);
}

const ROW_KINDS_FOR_CONSTRUCT = new Set(['group-conversation', 'other-conversation', 'conversation']);
