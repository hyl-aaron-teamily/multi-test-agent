// Multi-client sync test: several surfaces, each signed in as a different pool account, in the same
// conversation. Every round one client sends a unique line and every other client must show it.
//   roles      : e.g. desktop-web (Edge on this computer) + android-web + android-app (one phone)
//   endpoints  : each role leases a slot (endpoint × surface) and an account from the pools
//   one phone  : its app and its browser share one screen — the runner brings a role's app to the front
//                before acting for it (the other one is told it lost the screen on purpose)
//   observation: android-app reads the message text from the screen's accessibility tree (as the quote
//                check does); web surfaces ask the vision model about the screenshot. No page DOM is read.
// Black-box throughout: coordinates from the SKILL profiles, targets picked by the model at preparation.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { AndroidDriver } from '../drivers/android';
import { type Driver, type Point, sleep } from '../drivers/types';
import { dumpTree } from '../core/ui-tree';
import { WebDriver } from '../drivers/web';
import { pageHasText } from './observe';
import { addTier } from './stats';
import { RecordingDriver } from '../incident/recording-driver';
import { modelCalls } from '../core/model/llm';
import type { AccountPool, Lease } from '../platform/accounts/account-pool';
import { type Env, onAndroid, type Surface } from '../platform/accounts/types';
import { loadConversations } from '../platform/conversations';
import type { DevicePool } from '../platform/device-pool';
import type { TestPlan } from '../platform/schema/test-plan';
import type { Profile } from '../skills/profile';
import { runNode } from '../skills/teamily/nodes';
import { visionAsker, type VisionAsk, waitForRegion } from './checks';
import { enterApp, openSession, type Session } from './session';
import { pickTargets, visionLocator } from './targets';

export interface SyncRoleSpec {
  id: string;
  surface: Surface;
  /** Pin an endpoint (adb serial / host:<id>) or an account. */
  device?: string;
  account?: string;
}

export interface SyncOptions {
  env: Env;
  roles: SyncRoleSpec[];
  rounds?: number;
  /** Which conversation (guidance for the model; every account must be a member). */
  conversation?: string;
  /** Seconds a receiver may take to show the line. */
  timeoutSec?: number;
  /** Seconds to wait after every client is in the conversation, before round 1. */
  settleSec?: number;
  runDir: string;
  pool: AccountPool;
  devices: DevicePool;
  headed?: boolean;
  log?: (s: string) => void;
}

export interface SyncRoleResult {
  id: string;
  surface: Surface;
  endpoint: string;
  account: string;
  conversation?: string;
  ready: boolean;
  error?: string;
}

export interface SyncDelivery {
  receiver: string;
  seen: boolean | null;
  /** From the send to the first check that saw it (includes switching the phone's screen). */
  latencyMs?: number;
  checks: number;
  evidence?: string;
}

export interface SyncRound {
  round: number;
  sender: string;
  text: string;
  sentAt: string;
  deliveries: SyncDelivery[];
}

export interface SyncResult {
  env: Env;
  startedAt: string;
  finishedAt: string;
  roles: SyncRoleResult[];
  rounds: SyncRound[];
  conclusion: '全部同步' | '存在未同步' | '执行失败';
  detail: string;
  visionCalls: number;
  /** Delivery checks by tier (① accessibility / page text, ③ vision). */
  checkTiers?: Record<string, { n: number; ms: number }>;
}

interface Role {
  spec: SyncRoleSpec;
  res: SyncRoleResult;
  lease?: Lease;
  udid?: string;
  profile?: Profile;
  inner?: Driver;
  d?: RecordingDriver;
  sess?: Session;
  ask?: VisionAsk;
  target?: Point;
  /** The conversation title was read from the screen (not a vision guess). */
  titleRead?: boolean;
}

/** Without private settings: any group the test accounts share (no names in the code). */
const DEFAULT_CONVERSATION = () => loadConversations().sync.defaultConversation ?? 'a group conversation (avatar is a multi-person collage, or the title lists several members separated by commas) that all test accounts of this run belong to';

export async function runSync(o: SyncOptions): Promise<SyncResult> {
  const log = o.log ?? ((s: string) => console.log(`[sync] ${s}`));
  const t0 = Date.now();
  const v0 = modelCalls.vision;
  await mkdir(o.runDir, { recursive: true });
  const taskId = `sync-${t0}`;
  const tag = new Date(t0).toISOString().slice(11, 19).replace(/:/g, '');
  const result: SyncResult = { env: o.env, startedAt: new Date(t0).toISOString(), finishedAt: '', roles: [], rounds: [], conclusion: '执行失败', detail: '', visionCalls: 0 };
  // Phone roles lease first: their account is the one signed in on the phone; host roles take what is left.
  const roles: Role[] = [...o.roles]
    // Phones first (their account is fixed); the App before the browser — it reads the list reliably, so its
    // chosen title guides the others.
    .sort((a, b) => Number(onAndroid(b.surface)) - Number(onAndroid(a.surface)) || Number(b.surface === 'android-app') - Number(a.surface === 'android-app'))
    .map((spec) => ({ spec, res: { id: spec.id, surface: spec.surface, endpoint: '', account: '', ready: false } }));
  result.roles = roles.map((r) => r.res);
  /** Which role has the screen of each phone. */
  const front = new Map<string, Role>();
  const focus = async (r: Role) => {
    if (!r.udid || !onAndroid(r.spec.surface)) return;
    const cur = front.get(r.udid);
    if (cur === r) return;
    cur?.inner?.yieldFocus?.();
    await r.d!.focus();
    front.set(r.udid, r);
    await sleep(800);
  };

  try {
    // ---- leases: all or nothing
    for (const r of roles) {
      const lease = o.pool.lease(taskId, { env: o.env, surface: r.spec.surface, accountId: r.spec.account, devices: o.devices, device: r.spec.device });
      if (!lease) throw new Error(`no free ${o.env} account / endpoint slot for ${r.spec.id} (${r.spec.surface})`);
      r.lease = lease;
      r.res.account = lease.accounts[0].id;
      r.res.endpoint = lease.device?.udid ?? '-';
      r.udid = lease.device?.kind === 'android' ? lease.device.udid : undefined;
      log(`${r.spec.id}: ${r.spec.surface} on ${r.res.endpoint} as ${r.res.account}`);
    }
    // ---- each role: launch, sign in, home, pick + open the conversation
    let chosenTitle = '';
    for (const r of roles) {
      try {
        await prepareRole(r, o, log, focus, chosenTitle);
        // Only a title read from the screen guides the others (a vision-located row has no reliable title).
        if (!chosenTitle && r.titleRead) chosenTitle = r.res.conversation ?? '';
        r.res.ready = true;
      } catch (e) {
        r.res.error = (e as Error).message.split('\n')[0];
        log(`${r.spec.id}: preparation failed — ${r.res.error}`);
        if (r.d) await r.d.screenshot().then((png) => writeFile(join(o.runDir, `${r.spec.id}-prep-failed.png`), png)).catch(() => {});
      }
    }
    // Senders take turns in the order the roles were given (preparation order is phones first).
    const ready = roles.filter((r) => r.res.ready).sort((x, y) => o.roles.indexOf(x.spec) - o.roles.indexOf(y.spec));
    if (ready.length < 2) throw new Error(`fewer than two clients ready (${ready.map((r) => r.spec.id).join(', ') || 'none'})`);

    if (o.settleSec) {
      log(`settling ${o.settleSec}s before round 1`);
      await sleep(o.settleSec * 1000);
    }
    // ---- rounds: one sender, every other client must show the line
    const rounds = o.rounds ?? ready.length;
    for (let k = 1; k <= rounds; k++) {
      const sender = ready[(k - 1) % ready.length];
      const text = `autotest sync ${tag} r${k} ${sender.spec.id}`;
      await focus(sender);
      sender.d!.label = `send r${k}`;
      await runNode('teamily.sendMessage', { text }, { driver: sender.d!, profile: sender.profile!, targets: {} });
      const sentAt = Date.now();
      log(`round ${k}: ${sender.spec.id} sent "${text}"`);
      const round: SyncRound = { round: k, sender: sender.spec.id, text, sentAt: new Date(sentAt).toISOString(), deliveries: [] };
      round.deliveries.push(...(await awaitLine(ready.filter((x) => x !== sender), text, sentAt, o, focus, log, k)));
      // The sender must show its own line too (otherwise the send itself failed).
      const own = (await awaitLine([sender], text, sentAt, o, focus, log, k))[0];
      round.deliveries.push({ ...own, receiver: `${sender.spec.id} (sender)` });
      result.rounds.push(round);
    }
    const all = result.rounds.flatMap((r) => r.deliveries);
    const missed = all.filter((x) => x.seen === false);
    const unverified = all.filter((x) => x.seen === null);
    const notReady = roles.filter((r) => !r.res.ready);
    result.conclusion = missed.length ? '存在未同步' : unverified.length || notReady.length ? '执行失败' : '全部同步';
    const lat = all.filter((x) => x.seen && x.latencyMs !== undefined && !x.receiver.endsWith('(sender)')).map((x) => x.latencyMs!);
    result.detail = `${notReady.length ? `未就绪：${notReady.map((r) => r.spec.id).join(', ')}；` : ''}${result.rounds.length} 轮，${all.length} 次投递检查：可见 ${all.filter((x) => x.seen).length}，未出现 ${missed.length}，未能核实 ${unverified.length}${lat.length ? `；接收端从发送到看到 平均 ${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length / 100) / 10}s / 最长 ${Math.round(Math.max(...lat) / 100) / 10}s（含切换手机前台）` : ''}`;
  } catch (e) {
    result.conclusion = '执行失败';
    result.detail = (e as Error).message.split('\n')[0];
    log(`error: ${result.detail}`);
  } finally {
    for (const r of roles) {
      await r.inner?.close().catch(() => {});
      if (r.lease) o.pool.release(r.lease, o.devices);
    }
  }
  result.finishedAt = new Date().toISOString();
  result.visionCalls = modelCalls.vision - v0;
  result.checkTiers = { ...syncTiers };
  await writeFile(join(o.runDir, 'result.json'), JSON.stringify(result, null, 2));
  await writeFile(join(o.runDir, 'report.md'), syncMarkdown(result, o.runDir));
  return result;
}

async function prepareRole(r: Role, o: SyncOptions, log: (s: string) => void, focus: (r: Role) => Promise<void>, chosenTitle: string): Promise<void> {
  const sess = await openSession({ surface: r.spec.surface, env: o.env, account: r.res.account, udid: r.udid, pool: o.pool, headed: o.headed, log: (s) => log(`${r.spec.id}: ${s}`) });
  r.sess = sess;
  r.profile = sess.profile;
  r.inner = sess.inner;
  r.d = sess.d;
  const { d, profile } = sess;
  // Another role on this phone may have the screen: launching takes it (and tells the other one).
  if (r.udid) await focus(r).catch(() => {});
  await enterApp(sess, { chatTab: true });
  const guidance = chosenTitle
    ? `the conversation titled "${chosenTitle}" (the same group the other test clients opened; titles may be cut short with …)`
    : (o.conversation ?? DEFAULT_CONVERSATION());
  const plan = { targets: [{ id: 'conv', kind: 'group-conversation', guidance }] } as unknown as TestPlan;
  const [t] = await pickTargets(plan, r.inner, profile, (s) => log(`${r.spec.id}: ${s}`), await visionLocator(r.inner as any), 'rows');
  if (!t) throw new Error('conversation not found on the list');
  r.target = t.point;
  r.res.conversation = t.chosen;
  r.titleRead = t.by !== 'vision';
  await runNode('teamily.openConversation', { target: 'conv' }, { driver: d, profile, targets: { conv: t.point } });
  const open = await waitForRegion(d, profile, ['chat/composer'], 20_000);
  // The list re-sorts when messages arrive: make sure the header shows the chosen conversation (web: page
  // text in the chat pane header); otherwise pick and open again once.
  if (r.inner instanceof WebDriver && r.inner.page && t.by !== 'vision') {
    const head = t.chosen.replace(/[…\.]+$/, '').slice(0, 12);
    const inPane = r.spec.surface === 'desktop-web' ? { minX: chatPaneX(profile), maxY: 120 } : { maxY: 140 };
    if (!(await pageHasText(r.inner.page, { contains: head }, inPane))) {
      log(`${r.spec.id}: opened conversation is not "${head}" (list re-sorted) — opening again`);
      const [t2] = await pickTargets(plan, r.inner, profile, (s) => log(`${r.spec.id}: ${s}`), await visionLocator(r.inner as any), 'rows');
      if (t2) {
        if (r.spec.surface !== 'desktop-web') await sess.adapter.leaveConversation(d, profile);
        await runNode('teamily.openConversation', { target: 'conv' }, { driver: d, profile, targets: { conv: t2.point } });
        await waitForRegion(d, profile, ['chat/composer'], 20_000);
        r.target = t2.point;
      }
    }
  }
  if (!open) throw new Error('conversation did not open (composer not on screen)');
  // The app reopens a conversation where it was last scrolled to: scroll to the newest messages, as a
  // reader would, so new lines land on screen instead of behind a "↓ new" badge.
  if (r.spec.surface === 'android-app') {
    const x = Math.round(profile.viewport.width / 2);
    for (let i = 0; i < 6; i++) await d.swipe({ x, y: Math.round(profile.viewport.height * 0.7) }, { x, y: Math.round(profile.viewport.height * 0.25) }, 150);
    await sleep(800);
  }
  r.ask = await visionAsker(r.inner as any);
  log(`${r.spec.id}: in "${t.chosen.slice(0, 40)}"`);
}

/** Wait until every receiver shows the line: one check per receiver per pass (phones switch their screen
 *  between their roles), until all have it or the timeout passes. Latency = send → first check that saw it. */
async function awaitLine(rs: Role[], text: string, sentAt: number, o: SyncOptions, focus: (r: Role) => Promise<void>, log: (s: string) => void, round: number): Promise<SyncDelivery[]> {
  const deadline = sentAt + (o.timeoutSec ?? 45) * 1000;
  const out = new Map<Role, SyncDelivery>(rs.map((r) => [r, { receiver: r.spec.id, seen: false, checks: 0 }]));
  for (;;) {
    const pending = rs.filter((r) => out.get(r)!.seen !== true);
    if (!pending.length) break;
    for (const r of pending) {
      await focus(r);
      const d = out.get(r)!;
      d.checks++;
      const seen = await lineVisible(r, text);
      d.seen = seen === null && d.seen === false && d.checks === 1 ? null : (seen ?? d.seen);
      if (seen) d.latencyMs = Date.now() - sentAt;
    }
    if (Date.now() > deadline || rs.every((r) => out.get(r)!.seen === null)) break;
    await sleep(1500);
  }
  for (const r of rs) {
    const d = out.get(r)!;
    const evidence = join(o.runDir, `r${round}-${r.spec.id}.png`);
    await focus(r);
    await writeFile(evidence, await r.d!.screenshot()).catch(() => {});
    d.evidence = relative(o.runDir, evidence).replace(/\\/g, '/');
    log(`round ${round}: ${r.spec.id} ${d.seen ? `shows it (${Math.round(d.latencyMs! / 100) / 10}s, ${d.checks} checks)` : d.seen === null ? 'could not be checked (vision unavailable)' : `does NOT show it (${d.checks} checks)`}`);
  }
  return rs.map((r) => out.get(r)!);
}

/** Is the line on the receiver's screen? ① App: accessibility text; Playwright web: page text (read-only,
 *  W2-1 D4); phone browser: accessibility text when its tree is fresh. ③ vision on the screenshot otherwise.
 *  Each answer's tier is recorded (report). */
async function lineVisible(r: Role, text: string): Promise<boolean | null> {
  const key = text.match(/\d{6} r\d+/)?.[0] ?? text;
  const t0 = Date.now();
  const done = (v: boolean | null, tier: string) => {
    addTier(syncTiers, `${tier} ${r.spec.surface}`, Date.now() - t0);
    return v;
  };
  if (onAndroid(r.spec.surface) && r.inner instanceof AndroidDriver) {
    const nodes = await dumpTree(r.inner.o.udid, r.inner.o.packageName, 2);
    if (nodes.some((n) => n.text.includes(key) || n.desc.includes(key))) return done(true, '①');
    if (r.spec.surface === 'android-app' && nodes.length) return done(false, '①');
  } else if (r.inner instanceof WebDriver && r.inner.page) {
    // Desktop: only the chat pane (right of the conversation list, whose preview shows the line too).
    const v = await pageHasText(r.inner.page, { contains: key }, r.spec.surface === 'desktop-web' ? { minX: chatPaneX(r.profile!) } : { minY: r.profile!.viewport.height * 0.12 });
    if (v !== null) return done(v, '①');
  }
  if (!r.ask) return null;
  // Key on the unique part: the end of a bubble can sit under a floating button (the "@" jump badge).
  return done(await r.ask(`The chat on screen shows a message bubble containing "${key}" (its full text is "${text}"; the end of the text may be hidden behind a floating round button). Look at the newest messages at the bottom.`), '③');
}

/** Left edge of the desktop chat pane: right of the conversation list (search box right edge + margin). */
const chatPaneX = (p: Profile) => { const b = p.elements['chatlist.search']?.box; return b ? b[0] + b[2] + 60 : p.viewport.width * 0.22; };

/** Tier tally of delivery checks (this process). */
export const syncTiers: Record<string, { n: number; ms: number }> = {};

export function syncMarkdown(r: SyncResult, runDir: string): string {
  const lines = [
    `# 多端同步测试 — ${r.conclusion}`,
    '',
    `- 环境：${r.env}；${r.startedAt} → ${r.finishedAt}；视觉模型调用 ${r.visionCalls}`,
    `- 投递核对分层：${Object.entries(r.checkTiers ?? {}).map(([k, v]) => `${k} ×${v.n}（平均 ${Math.round(v.ms / v.n)}ms）`).join('，') || '-'}`,
    `- ${r.detail}`,
    '',
    '| 端 | 执行端 | 设备 / 主机 | 账号 | 会话 | 就绪 |',
    '|---|---|---|---|---|---|',
    ...r.roles.map((x) => `| ${x.id} | ${x.surface} | ${x.endpoint} | ${x.account} | ${(x.conversation ?? '-').slice(0, 40)} | ${x.ready ? '✅' : `❌ ${x.error ?? ''}`} |`),
    '',
  ];
  for (const k of r.rounds) {
    lines.push(`## 第 ${k.round} 轮：${k.sender} 发送「${k.text}」`, '', '| 接收端 | 结果 | 发送到看到 | 检查次数 | 截图 |', '|---|---|---|---|---|');
    for (const d of k.deliveries) lines.push(`| ${d.receiver} | ${d.seen === null ? '未能核实' : d.seen ? '✅ 可见' : '❌ 未出现'} | ${d.latencyMs !== undefined ? `${(d.latencyMs / 1000).toFixed(1)}s` : '-'} | ${d.checks} | ${d.evidence ? `![](${d.evidence})` : '-'} |`);
    lines.push('');
  }
  lines.push(`结果目录：\`${relative(resolve('.'), runDir).replace(/\\/g, '/')}\``, '');
  return lines.join('\n');
}
