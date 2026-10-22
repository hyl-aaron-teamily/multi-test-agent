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
import { adb } from '../core/adb';
import { AndroidDriver } from '../drivers/android';
import { createDriver, profileKey } from '../drivers/factory';
import { type Driver, type Point, sleep } from '../drivers/types';
import { WebDriver } from '../drivers/web';
import { parseNodes } from '../imui/clients/android';
import { RecordingDriver } from '../incident/recording-driver';
import { modelCalls } from '../issue/llm';
import type { AccountPool, Lease } from '../platform/accounts/account-pool';
import { ensureWebSession, type PlaywrightSurface } from '../platform/accounts/sessions';
import { type Env, onAndroid, onPlaywright, type Surface } from '../platform/accounts/types';
import { ensureUiLogin } from '../platform/accounts/ui-login';
import type { DevicePool } from '../platform/device-pool';
import type { TestPlan } from '../platform/schema/test-plan';
import { loadProfile, pointOf, type Profile, SkillStaleError } from '../skills/profile';
import { runNode } from '../skills/teamily/nodes';
import { assertSkillFresh, visionAsker, type VisionAsk, waitForRegion } from './checks';
import { toChatListAndroidWeb } from './run';
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
}

interface Role {
  spec: SyncRoleSpec;
  res: SyncRoleResult;
  lease?: Lease;
  udid?: string;
  profile?: Profile;
  inner?: Driver;
  d?: RecordingDriver;
  ask?: VisionAsk;
  target?: Point;
}

const DEFAULT_CONVERSATION = 'a group conversation (avatar is a multi-person collage, or the title lists several members separated by commas) that the test accounts aaron+test1, aaron+test2 and aaron+test3 all belong to; prefer the one whose title starts with 黄悦龙Aaron';

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
    .sort((a, b) => Number(onAndroid(b.surface)) - Number(onAndroid(a.surface)))
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
        chosenTitle ||= r.res.conversation ?? '';
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
  await writeFile(join(o.runDir, 'result.json'), JSON.stringify(result, null, 2));
  await writeFile(join(o.runDir, 'report.md'), syncMarkdown(result, o.runDir));
  return result;
}

async function prepareRole(r: Role, o: SyncOptions, log: (s: string) => void, focus: (r: Role) => Promise<void>, chosenTitle: string): Promise<void> {
  const name = profileKey(r.spec.surface, o.env, r.udid);
  const profile = loadProfile(name);
  if (!profile) throw new Error(`no SKILL profile ${name} — calibrate it first`);
  r.profile = profile;
  const url = o.pool.webUrl(o.env);
  let storageState: string | undefined;
  if (onPlaywright(r.spec.surface)) {
    const s = await ensureWebSession(o.pool, r.res.account, r.spec.surface as PlaywrightSurface);
    if (!s.ok) throw new Error(`login ${r.res.account}: ${s.error}`);
    storageState = s.file;
  }
  r.inner = createDriver({ surface: r.spec.surface, profile, url, udid: r.udid, storageState, headless: !o.headed });
  r.d = new RecordingDriver(r.inner);
  const d = r.d;
  // Another role on this phone may have the screen: launching takes it (and tells the other one).
  if (r.udid) await focus(r).catch(() => {});
  await d.launch();
  if (r.inner instanceof WebDriver) await sleep(8000);
  else if (r.spec.surface === 'android-web') await waitForRegion(d, profile, ['home/nav', 'chat/composer', 'login/form'], 45_000);
  if (r.spec.surface === 'android-web') await d.redacted(() => ensureUiLogin(d, profile, o.pool, r.res.account, log));
  for (let i = 0; ; i++) {
    try {
      await assertSkillFresh(d, profile);
      break;
    } catch (e) {
      if (!(e instanceof SkillStaleError) || i >= 3) throw e;
      if (r.spec.surface === 'android-web') await toChatListAndroidWeb(d, r.inner as AndroidDriver, profile, log);
      else if (r.spec.surface === 'android-app') {
        await d.back();
        await sleep(1500);
      } else throw e;
    }
  }
  // The bottom bar looks the same on every tab: make sure the chat tab is the one showing.
  if (onAndroid(r.spec.surface) && profile.elements['nav.chat']) {
    await d.tap(pointOf(profile, 'nav.chat'));
    await sleep(1500);
  }
  d.drainAnomalies();
  const guidance = chosenTitle
    ? `the conversation titled "${chosenTitle}" (the same group the other test clients opened; titles may be cut short with …)`
    : (o.conversation ?? DEFAULT_CONVERSATION);
  const plan = { targets: [{ id: 'conv', kind: 'group-conversation', guidance }] } as unknown as TestPlan;
  const [t] = await pickTargets(plan, r.inner, profile, (s) => log(`${r.spec.id}: ${s}`), await visionLocator(r.inner as any), 'rows');
  if (!t) throw new Error('conversation not found on the list');
  r.target = t.point;
  r.res.conversation = t.chosen;
  await runNode('teamily.openConversation', { target: 'conv' }, { driver: d, profile, targets: { conv: t.point } });
  const open = await waitForRegion(d, profile, ['chat/composer'], 20_000);
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

/** Is the line on the receiver's screen? App: accessibility text. Web: vision on the screenshot. */
async function lineVisible(r: Role, text: string): Promise<boolean | null> {
  if (r.spec.surface === 'android-app' && r.inner instanceof AndroidDriver) {
    await adb(['shell', 'uiautomator', 'dump', '/sdcard/autotest_ui.xml'], r.inner.o.udid).catch(() => '');
    const nodes = parseNodes(await adb(['exec-out', 'cat', '/sdcard/autotest_ui.xml'], r.inner.o.udid).catch(() => ''), r.inner.o.packageName);
    return nodes.some((n) => n.text.includes(text) || n.desc.includes(text));
  }
  if (!r.ask) return null;
  // Key on the unique part: the end of a bubble can sit under a floating button (the "@" jump badge).
  const key = text.match(/\d{6} r\d+/)?.[0] ?? text;
  return r.ask(`The chat on screen shows a message bubble containing "${key}" (its full text is "${text}"; the end of the text may be hidden behind a floating round button). Look at the newest messages at the bottom.`);
}

export function syncMarkdown(r: SyncResult, runDir: string): string {
  const lines = [
    `# 多端同步测试 — ${r.conclusion}`,
    '',
    `- 环境：${r.env}；${r.startedAt} → ${r.finishedAt}；视觉模型调用 ${r.visionCalls}`,
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
