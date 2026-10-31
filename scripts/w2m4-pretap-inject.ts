// W2-4 T4/T8 §7.4 device injection: on the real phone, take a conversation row from the live tree, then
// feed the pre-tap guard the row's point shifted by 0 / 60 / 200 px and a target that is not on screen.
// Taps go to a recording stub — nothing is pressed on the phone. Expected: pass / corrected / shifted (blocked)
// / gone (blocked).
//   npx tsx scripts/w2m4-pretap-inject.ts [--device 4f2ebdf2] [--out docs/w2m4/pretap-inject.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { label } from '../core/screen-index';
import { treeBackendOf } from '../core/tree-backend';
import { AndroidDriver } from '../drivers/android';
import { TEAMILY_PACKAGE } from '../drivers/factory';
import { PreTapBlocked, PreTapGuard } from '../executor/pretap';
import { selectTreeBackend } from '../executor/session';
import { snapshot } from '../executor/snapshot';
import { RecordingDriver } from '../incident/recording-driver';

const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const udid = arg('device') ?? '4f2ebdf2';
const out = arg('out');

async function main() {
  await selectTreeBackend(udid, console.log);
  const d = new AndroidDriver({ udid, packageName: TEAMILY_PACKAGE });
  const s = await snapshot(d);
  const rows = s.nodes.filter((n) => n.clickable && n.box[2] > s.width * 0.8 && n.box[3] > 150 && n.box[3] < 400);
  const row = rows.find((r) => s.nodes.some((n) => n !== r && n.text && n.box[1] >= r.box[1] && n.box[1] + n.box[3] <= r.box[1] + r.box[3]));
  if (!row) throw new Error('no conversation row on screen — open Teamily on its home list first');
  const title = s.nodes.find((n) => n !== row && n.text && n.box[1] >= row.box[1] && n.box[1] + n.box[3] <= row.box[1] + row.box[3])!;
  console.log(`row "${label(title)}" box ${JSON.stringify(row.box)} centre ${JSON.stringify(row.center)} (backend ${treeBackendOf(udid)}, tree ${s.ms.tree} ms)`);

  const taps: { x: number; y: number }[] = [];
  const stub = { surface: 'android-app', tap: async (p: { x: number; y: number }) => void taps.push(p), longPress: async () => {}, screenshot: () => d.screenshot() } as any;
  const rd = new RecordingDriver(stub);
  const g = new PreTapGuard(d, { log: console.log }).attach(rd);
  const ref = { purpose: `row "${label(title)}"`, text: label(title), box: row.box };
  const cases = [
    { name: 'same point', p: row.center, ref, want: 'pass' },
    { name: '+60 px', p: { x: row.center.x, y: row.center.y + 60 }, ref, want: 'corrected' },
    { name: '+200 px', p: { x: row.center.x, y: row.center.y + 200 }, ref, want: 'shifted' },
    { name: 'target not on screen', p: row.center, ref: { purpose: 'missing row', text: '不存在的会话-w2m4', box: row.box }, want: 'gone' },
  ];
  const results: Record<string, unknown>[] = [];
  await g.during('inject', async () => {
    for (const c of cases) {
      await g.remember(c.p, c.ref);
      const before = taps.length;
      let kind = '';
      try {
        await rd.tap(c.p);
        kind = g.events.at(-1)!.kind;
      } catch (e) {
        kind = e instanceof PreTapBlocked ? e.event.kind : `error: ${(e as Error).message}`;
      }
      const tapped = taps.length > before ? taps.at(-1) : null;
      results.push({ case: c.name, from: c.p, want: c.want, got: kind, tapped, ok: kind === c.want, detail: g.events.at(-1)?.detail });
      console.log(`${kind === c.want ? '✓' : '✗'} ${c.name}: ${kind}${tapped ? ` → tapped (${tapped.x},${tapped.y})` : ' → not tapped'} — ${g.events.at(-1)?.detail}`);
    }
  });
  const ok = results.every((r) => r.ok);
  console.log(`${ok ? 'OK' : 'FAIL'} ${results.filter((r) => r.ok).length}/${results.length}; ${g.reportLines()[0]}`);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), udid, backend: treeBackendOf(udid), row: { title: label(title), box: row.box, centre: row.center }, results, tally: g.tally }, null, 2));
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
