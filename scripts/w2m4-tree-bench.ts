// W2-4 §7.1: tree-read speed and agreement on the real phone. For the conversation list and a chat page
// (the account's own Personal AI conversation, opened by tapping its row like a user): N reads with each
// backend (p50 / p95), and node agreement between the two backends on the same screen — nodes of the app
// that carry text or a description, keyed by label + bounds.
//   npx tsx scripts/w2m4-tree-bench.ts [--device 4f2ebdf2] [--n 50] [--out docs/w2m4/tree-bench.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { a11yBackend, activateA11y } from '../core/a11y-service';
import { adb, launchApp } from '../core/adb';
import { percentiles, uiautomatorBackend } from '../core/tree-backend';
import { clickableAncestor, findByText, nodeCenter, parseNodes } from '../core/ui-tree';
import { TEAMILY_PACKAGE } from '../drivers/factory';

const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const udid = arg('device') ?? '4f2ebdf2';
const N = Number(arg('n') ?? 50);
const out = arg('out');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pure: labelled app nodes keyed by label + bounds. */
export function keys(xml: string): Set<string> {
  return new Set(parseNodes(xml, TEAMILY_PACKAGE).filter((n) => (n.text || n.desc).trim()).map((n) => `${(n.text || n.desc).trim()}|${n.x1},${n.y1},${n.x2},${n.y2}`));
}

async function timed(b: typeof uiautomatorBackend, n: number) {
  const ms: number[] = [];
  let fails = 0;
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    try {
      const x = await b.dump(udid, 20_000);
      if (!/<node\b/.test(x)) throw new Error('empty');
      ms.push(Date.now() - t);
    } catch {
      fails++;
    }
  }
  return { ...percentiles(ms), fails, min: Math.min(...ms), max: Math.max(...ms) };
}

async function agreement() {
  // Same screen, back to back (the list may tick a timestamp between reads: take the best of 3 pairs).
  let best = { coverage: 0, jaccard: 0, ua: 0, svc: 0, onlyUa: [] as string[], onlySvc: [] as string[] };
  for (let i = 0; i < 3; i++) {
    const a = keys(await uiautomatorBackend.dump(udid, 20_000));
    const b = keys(await a11yBackend().dump(udid, 5000));
    const both = [...a].filter((k) => b.has(k)).length;
    const r = { coverage: both / Math.max(1, a.size), jaccard: both / Math.max(1, new Set([...a, ...b]).size), ua: a.size, svc: b.size, onlyUa: [...a].filter((k) => !b.has(k)).slice(0, 10), onlySvc: [...b].filter((k) => !a.has(k)).slice(0, 10) };
    if (r.coverage > best.coverage) best = r;
  }
  return best;
}

async function screen(name: string) {
  console.log(`[${name}] agreement…`);
  const agree = await agreement();
  console.log(`[${name}] uiautomator ×${N}…`);
  const ua = await timed(uiautomatorBackend, N);
  console.log(`[${name}] a11y-service ×${N}…`);
  const svc = await timed(a11yBackend(), N);
  console.log(`[${name}] uiautomator p50 ${ua.p50} / p95 ${ua.p95} ms; a11y-service p50 ${svc.p50} / p95 ${svc.p95} ms; agreement ${(agree.coverage * 100).toFixed(1)}% of uiautomator's ${agree.ua} labelled nodes (Jaccard ${(agree.jaccard * 100).toFixed(1)}%)`);
  return { screen: name, uiautomator: ua, a11yService: svc, agreement: agree };
}

async function main() {
  const act = await activateA11y(udid);
  if (!act.ok) throw new Error(`a11y-service not usable: ${act.reason}`);
  // The app on its conversation list (launch it if another app is in front).
  if (!/ai\.teamily\.mobile/.test(await adb(['shell', 'dumpsys window | grep -m1 mCurrentFocus'], udid).catch(() => ''))) {
    await launchApp(TEAMILY_PACKAGE, udid);
    await sleep(6000);
  }
  const results = [await screen('conversation list')];
  // Open the own Personal AI conversation from the list (an in-app tap, nothing sent).
  // The first tap after the app sat idle on the list sometimes does not register: verify, tap again.
  const inChat = async () => parseNodes(await a11yBackend().dump(udid, 5000), TEAMILY_PACKAGE).some((n) => /EditText/.test(n.cls));
  for (let i = 0; i < 3 && !(await inChat()); i++) {
    const nodes = parseNodes(await a11yBackend().dump(udid, 5000), TEAMILY_PACKAGE);
    const row = findByText(nodes, 'Personal AI');
    if (!row) throw new Error('Personal AI row not on the list');
    const p = nodeCenter(clickableAncestor(nodes, row.node) ?? row.node);
    await adb(['shell', `input tap ${p.x} ${p.y}`], udid);
    await sleep(3000);
  }
  if (!(await inChat())) throw new Error('chat page did not open');
  results.push(await screen('chat page'));
  // Back to the list (only from the chat page: Back on the list would leave the app).
  if (await inChat()) await adb(['shell', 'input keyevent 4'], udid);
  const ok = results.every((r) => r.a11yService.p95 <= 500 && r.agreement.coverage >= 0.95);
  console.log(`${ok ? 'PASS' : 'CHECK'}: target p95 ≤ 500 ms and agreement ≥ 95% on both screens`);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), udid, n: N, results }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
