// `autotest blocks check [--device <udid>] [--n 20] [--only a,b] [--send]` — block health (W3-7 §4, E5 ①).
// Runs the common Teamily blocks on one device, each N times in one session, and records the success rate, the
// failure texts (most frequent first) and the block version (hash of the Node code) in
// platform/state/block-health.json, per device: a block failing on one device only is a device difference, not
// a plan error. A block that went from failing to passing re-queues the Issues whose repair stopped on it
// (§8.1 ⑪) when the platform is up.
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorKind, sleep } from '../drivers/types';
import { AndroidDriver } from '../drivers/android';
import { closeSession, enterApp, openSession } from '../engine/session';
import { leaseFor } from '../engine/lease';
import { loadConversations } from '../platform/conversations';
import type { NodeContext } from '../skills/teamily/nodes';
import { execAction } from '../engine/plan/actions';
import type { PlannedAction } from '../platform/schema/test-plan';

const step = (name: string, input: Record<string, unknown>): PlannedAction => ({ type: 'node', node: { name, input }, delayAfterMs: 300 });

export const HEALTH_FILE = resolve(process.env.AUTOTEST_BLOCK_HEALTH ?? 'platform/state/block-health.json');
/** Pass mark (W3-7 §4: 20 runs, at least 19). */
export const PASS_RATE = 0.95;

export interface BlockHealth {
  block: string;
  version: string;
  runs: number;
  ok: number;
  /** Failure texts, most frequent first (numbers folded). */
  fails: { text: string; n: number; kind?: string }[];
  at: string;
}
export type HealthFile = { schemaVersion: 1; devices: Record<string, Record<string, BlockHealth>> };

/** The version of the blocks: the Node code (a change of nodes.ts is a new version). */
export const blockVersion = () => createHash('sha256').update(readFileSync('skills/teamily/nodes.ts')).digest('hex').slice(0, 12);

export function readHealth(file = HEALTH_FILE): HealthFile {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as HealthFile;
    return j?.schemaVersion === 1 && j.devices ? j : { schemaVersion: 1, devices: {} };
  } catch {
    return { schemaVersion: 1, devices: {} };
  }
}

/** Pure: does the block pass on this record? */
export const healthy = (h: BlockHealth | undefined) => !!h && h.runs > 0 && h.ok / h.runs >= PASS_RATE;

/** Pure: blocks that failed before and pass now (the re-queue trigger), per device. */
export function nowFixed(before: HealthFile, after: HealthFile, udid: string): string[] {
  const a = after.devices[udid] ?? {};
  const b = before.devices[udid] ?? {};
  return Object.keys(a).filter((k) => healthy(a[k]) && b[k] && !healthy(b[k]));
}

/** Pure: fold failure texts (numbers, run tokens) and count. */
export function foldFails(xs: { text: string; kind?: string }[]): BlockHealth['fails'] {
  const m = new Map<string, { n: number; kind?: string }>();
  for (const x of xs) {
    const k = x.text.replace(/\d+/g, '#').slice(0, 200);
    const c = m.get(k);
    m.set(k, { n: (c?.n ?? 0) + 1, kind: x.kind ?? c?.kind });
  }
  return [...m].map(([text, v]) => ({ text, ...v })).sort((a, b) => b.n - a.n);
}

/** Pure: the block an executor failure names (`teamily.<x>` in its text), for the re-queue (§8.1 ⑪). */
export const blockOf = (text: string) => text.match(/teamily\.\w+/)?.[0] ?? (/composer did not take focus/.test(text) ? 'focusComposer' : undefined);

interface Trial {
  name: string;
  /** Run once; throws on failure. */
  run: (c: Ctx) => Promise<void>;
  /** Back to where the next run starts. */
  reset: (c: Ctx) => Promise<void>;
  sends?: boolean;
}

interface Ctx {
  node: NodeContext;
  exec: (a: PlannedAction) => Promise<void>;
  home: () => Promise<void>;
  openConv: () => Promise<void>;
  android: AndroidDriver;
  token: string;
}

const TRIALS: Trial[] = [
  {
    name: 'teamily.openConversation',
    run: async (c) => c.openConv(),
    reset: async (c) => c.home(),
  },
  {
    name: 'focusComposer',
    run: async (c) => {
      await c.exec(step('teamily.typeMention', {}));
      await c.exec(step('teamily.clearComposer', {}));
    },
    reset: async () => {},
  },
  {
    name: 'teamily.sendMessage',
    sends: true,
    run: async (c) => c.exec(step('teamily.sendMessage', { text: `block-check ${c.token}` })),
    reset: async () => {},
  },
  {
    name: 'teamily.openSettings',
    run: async (c) => {
      await c.home();
      await c.exec(step('teamily.openSettings', {}));
    },
    reset: async (c) => c.home(),
  },
];

export async function blockCheck(o: { udid?: string; n: number; only?: string[]; send?: boolean; log?: (s: string) => void }): Promise<{ udid: string; results: BlockHealth[]; fixed: string[] }> {
  const log = o.log ?? ((s: string) => console.log(`[blocks] ${s}`));
  const { openPools } = await import('../platform/pools');
  const { pool, devices } = await openPools();
  const env = 'prod' as const;
  const leased = await leaseFor({ pool, devices, env, surface: 'android-app', udid: o.udid, taskId: `block-check-${Date.now()}`, log });
  if ('error' in leased) throw new Error(leased.error);
  const { lease, account, udid } = leased;
  if (!udid) throw new Error('no device');
  const before = readHealth();
  const results: BlockHealth[] = [];
  const sess = await openSession({ surface: 'android-app', env, account: account.id, udid, pool, log });
  try {
    await enterApp(sess, { chatTab: true });
    const android = sess.inner as AndroidDriver;
    const { dumpTree } = await import('../core/ui-tree');
    const { locateText } = await import('../engine/locate');
    const node: NodeContext = {
      driver: sess.d,
      profile: sess.profile,
      targets: {},
      credentials: () => pool.backend.get(account.id),
      locate: async (_desc, texts, newest) => (await locateText(sess.inner, texts, newest))?.point ?? null,
      findAll: async (texts, cls) =>
        (await dumpTree(udid, '', 2))
          .filter((n) => (!texts.length || texts.includes(n.text.trim()) || texts.includes(n.desc.trim())) && (!cls || cls.test(n.cls)))
          .map((n) => ({ point: { x: Math.round((n.x1 + n.x2) / 2), y: Math.round((n.y1 + n.y2) / 2) }, box: [n.x1, n.y1, n.x2 - n.x1, n.y2 - n.y1] as [number, number, number, number], cls: n.cls, clickable: n.clickable, label: n.text || n.desc })),
    };
    const conv = loadConversations().construct.allow[0];
    if (!conv) throw new Error('platform/conversations.local.yaml has no allow-listed conversation');
    const ctx: Ctx = {
      node,
      android,
      token: Date.now().toString(36),
      exec: async (a) => void (await execAction(a, node, sess.profile, node.targets)),
      home: async () => {
        for (let i = 0; i < 3; i++) await sess.adapter.recoverHome(sess, i).catch(() => {});
      },
      openConv: async () => {
        const row = ((await node.findAll!([conv])) ?? []).find((x) => x.clickable) ?? ((await node.findAll!([conv])) ?? [])[0];
        if (!row) throw new Error(`conversation "${conv}" not on the home list`);
        node.targets.conv = row.point;
        await execAction(step('teamily.openConversation', { target: 'conv' }), node, sess.profile, node.targets);
        await sleep(800);
        if (!(await dumpTree(udid, '', 2)).some((n) => /EditText/.test(n.cls))) throw new Error('teamily.openConversation: the chat page (composer) did not open');
      },
    };
    for (const t of TRIALS) {
      if (o.only && !o.only.includes(t.name)) continue;
      if (t.sends && !o.send) continue;
      const fails: { text: string; kind?: string }[] = [];
      let ok = 0;
      await ctx.home();
      if (t.name !== 'teamily.openConversation' && t.name !== 'teamily.openSettings') await ctx.openConv().catch((e) => log(`${t.name}: could not open the conversation first — ${(e as Error).message}`));
      for (let i = 0; i < o.n; i++) {
        try {
          await t.run(ctx);
          ok++;
        } catch (e) {
          fails.push({ text: (e as Error).message.split('\n')[0], kind: errorKind(e) });
        }
        await t.reset(ctx).catch(() => {});
        if (t.name !== 'teamily.openConversation' && t.name !== 'teamily.openSettings' && fails.length && !(await dumpTree(udid, '', 2)).some((n) => /EditText/.test(n.cls))) await ctx.openConv().catch(() => {});
      }
      const h: BlockHealth = { block: t.name, version: blockVersion(), runs: o.n, ok, fails: foldFails(fails), at: new Date().toISOString() };
      results.push(h);
      log(`${t.name}: ${ok}/${o.n}${h.fails[0] ? ` — most failures: ${h.fails[0].text} (${h.fails[0].n})` : ''}`);
    }
  } finally {
    await closeSession(sess);
    pool.release(lease!, devices);
  }
  const after = readHealth();
  after.devices[udid] = { ...(after.devices[udid] ?? {}), ...Object.fromEntries(results.map((r) => [r.block, r])) };
  mkdirSync(dirname(HEALTH_FILE), { recursive: true });
  writeFileSync(HEALTH_FILE, JSON.stringify(after, null, 2));
  const fixed = nowFixed(before, after, udid);
  return { udid, results, fixed };
}

/** §8.1 ⑪: Issues whose last repair stopped on an executor failure of a block that passes now → run again. */
export async function requeueFixed(fixed: string[], log = (s: string) => console.log(`[blocks] ${s}`)): Promise<string[]> {
  if (!fixed.length) return [];
  const { listTasks } = await import('../platform/lifecycle/task');
  const port = Number(process.env.PLATFORM_PORT ?? 3210);
  const latest = new Map<string, { issue: string; block?: string }>();
  for (const t of listTasks().filter((t) => t.kind === 'issue').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) latest.set(t.issue, { issue: t.issue, block: Object.values(t.repair ?? {}).map((x) => (x.executor ? blockOf(x.executor.detail) : undefined)).find(Boolean) });
  const out: string[] = [];
  for (const { issue, block } of latest.values()) {
    if (!block || !fixed.includes(block)) continue;
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/issues/${encodeURIComponent(issue)}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: `积木 ${block} 已修复（体检通过），自动重跑` }) }).catch(() => undefined);
    log(`${issue}: ${r?.ok ? `已排队（积木 ${block} 已修复）` : `没能排队（平台没开？HTTP ${r?.status ?? '-'}）`}`);
    if (r?.ok) out.push(issue);
  }
  return out;
}

if (process.argv[1] && /block-check\.ts$/.test(process.argv[1])) {
  const a = process.argv.slice(2);
  const flag = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  blockCheck({ udid: flag('device'), n: Number(flag('n') ?? 20), only: flag('only')?.split(','), send: a.includes('--send') })
    .then(async (r) => {
      console.log(`[blocks] ${r.udid}: ${r.results.map((x) => `${x.block} ${x.ok}/${x.runs}`).join(', ')} → ${HEALTH_FILE}`);
      if (r.fixed.length) await requeueFixed(r.fixed);
      process.exit(r.results.every(healthy) ? 0 : 1);
    })
    .catch((e) => {
      console.error(`[blocks] ${(e as Error).message}`);
      process.exit(2);
    });
}
void existsSync;
