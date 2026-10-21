// Coordinate replay of an incident (milestone 5 §D.4):
//   - same verdict rule as the original plan (1 hit / 3 consecutive hits), not "n/N"
//   - deviation: round-end screenshot hash vs the original round-end hash → "from round k the path differs",
//     separating "not reproduced" from "never reached the spot"
//   - variants: original pace / fast (×0.5) / slow (×2) / cold (force-stop + launch first); --variants all
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { adb } from '../core/adb';
import { decodePng, dHash, hamming } from '../core/image';
import { evaluateVisual } from '../executor/checks';
import { VerdictTracker } from '../executor/verdict';
import { AndroidDriver } from '../drivers/android';
import { type Anomaly, type Driver, sleep } from '../drivers/types';
import { WebDriver } from '../drivers/web';
import { AccountPool } from '../platform/accounts/account-pool';
import { ensureWebSession } from '../platform/accounts/sessions';
import { loadProfile } from '../skills/profile';
import type { ReplayFile } from './bundle';
import type { CoordOp } from './recording-driver';

export type Variant = 'original' | 'fast' | 'slow' | 'cold';
const PACE: Record<Variant, number> = { original: 1, fast: 0.5, slow: 2, cold: 1 };
// Video frame vs live screenshot of the same screen differ by ~12–17 bits (scaling, status bar); 24 = different screen.
export const DEVIATION_DISTANCE = 24;

export interface VariantResult {
  variant: Variant;
  reproduced: boolean;
  hits: number;
  rounds: number;
  firstDeviationRound?: number;
  deviations: { round: number; distance: number }[];
  hitDetails: string[];
}

/** Pure: first round whose end frame is too far from the original. */
export function firstDeviation(orig: (string | undefined)[], now: (string | undefined)[], limit = DEVIATION_DISTANCE): { index: number; distance: number } | undefined {
  for (let i = 0; i < Math.min(orig.length, now.length); i++) {
    if (!orig[i] || !now[i]) continue;
    const d = hamming(orig[i]!, now[i]!);
    if (d > limit) return { index: i, distance: d };
  }
  return undefined;
}

async function playOp(d: Driver, op: CoordOp): Promise<void> {
  switch (op.op) {
    case 'tap':
      return d.tap(op.point!);
    case 'longPress':
      return d.longPress(op.point!, op.ms);
    case 'type':
      if (op.value === '<redacted>') throw new Error('replay contains a redacted credential op');
      return d.type(op.value ?? '');
    case 'key':
      return d.key(op.value ?? 'Enter');
    case 'swipe':
      return d.swipe(op.point!, op.to!, op.ms);
    case 'scroll':
      return d.scroll(op.point!, op.ms ?? 300);
    case 'back':
      return d.back();
    case 'launch':
      return d.launch();
    default:
      return;
  }
}

export async function replayIncident(file: string, variant: Variant, log = (s: string) => console.log(`[replay] ${s}`)): Promise<VariantResult> {
  const r: ReplayFile = JSON.parse(await readFile(file, 'utf8'));
  const profile = loadProfile(r.profile);
  if (!profile) throw new Error(`profile ${r.profile} missing — recalibrate`);
  if (profile.skillVersion !== r.skillVersion) log(`warning: SKILL ${profile.skillVersion} ≠ recorded ${r.skillVersion}`);
  let d: Driver;
  if (r.surface === 'android-app') {
    const udid = r.profile.match(/^android-(.+)@/)![1];
    d = new AndroidDriver({ udid, packageName: r.packageName ?? 'ai.teamily.mobile' });
    if (variant === 'cold') await adb(['shell', 'am', 'force-stop', r.packageName ?? 'ai.teamily.mobile'], udid);
  } else {
    const pool = new AccountPool();
    await pool.reload();
    const s = await ensureWebSession(pool, r.account!, r.surface);
    if (!s.ok) throw new Error(`login ${r.account}: ${s.error}`);
    d = new WebDriver({ surface: r.surface, url: r.url!, storageState: s.file });
  }
  const tracker = new VerdictTracker(r.verdictRule);
  const res: VariantResult = { variant, reproduced: false, hits: 0, rounds: 0, deviations: [], hitDetails: [] };
  const anomalies: Anomaly[] = [];
  try {
    await d.launch();
    await sleep(r.surface === 'android-app' ? 2500 : 8000);
    d.drainAnomalies();
    const play = async (ops: CoordOp[]) => {
      for (let i = 0; i < ops.length; i++) {
        await playOp(d, ops[i]);
        const gap = i + 1 < ops.length ? ops[i + 1].at - ops[i].at - ops[i].durationMs : 300;
        await sleep(Math.max(0, Math.min(2000, gap * PACE[variant])));
        anomalies.push(...d.drainAnomalies());
      }
    };
    await play(r.setupOps);
    // Up to 3 passes for the consecutive rule; one pass otherwise.
    const passes = 'anyHit' in r.verdictRule ? 1 : 3;
    const orig = r.rounds.map((x) => x.endHash);
    for (let pass = 0; pass < passes && !tracker.reproduced(); pass++) {
      const now: (string | undefined)[] = [];
      for (const round of r.rounds) {
        anomalies.length = 0;
        await play(round.ops);
        const png = await d.screenshot();
        now.push(dHash(decodePng(png)));
        let hit = anomalies.find((a) => ['crash', 'anr', 'app-exit', 'page-crash'].includes(a.kind))?.detail;
        if (!hit) {
          for (const c of r.checks.filter((c) => c.kind === 'visual-region')) {
            const cr = await evaluateVisual(d, profile, c, undefined, png);
            if (cr.pass === false) hit = `check failed: ${c.expect} (${cr.detail})`;
          }
        }
        res.rounds++;
        if (hit) res.hitDetails.push(`pass ${pass + 1} round ${round.round}: ${hit.slice(0, 200)}`);
        if (tracker.record(!!hit)) break;
      }
      const dev = firstDeviation(orig, now);
      if (dev && res.firstDeviationRound === undefined) res.firstDeviationRound = r.rounds[dev.index].round;
      res.deviations.push(...now.map((h, i) => ({ round: r.rounds[i]?.round, distance: h && orig[i] ? hamming(h, orig[i]!) : -1 })).filter((x) => x.round !== undefined));
    }
  } finally {
    await d.close();
  }
  res.hits = tracker.hits;
  res.reproduced = tracker.reproduced();
  return res;
}

export async function replayCmd(args: string[]): Promise<number> {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file || !existsSync(file)) throw new Error('usage: autotest replay <incident>/replay.json [--variant original|fast|slow|cold|all]');
  const v = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : 'original';
  const variants: Variant[] = v === 'all' ? ['original', 'fast', 'slow', 'cold'] : [v as Variant];
  const results: VariantResult[] = [];
  for (const x of variants) {
    const r = await replayIncident(file, x);
    console.log(`[replay] ${x}: ${r.reproduced ? '能复现' : '未复现'} (hits ${r.hits}/${r.rounds} rounds)${r.firstDeviationRound !== undefined ? `；第 ${r.firstDeviationRound} 轮起与原路径不同（没走到出事位置）` : '；路径与原现场一致'}`);
    results.push(r);
  }
  const rep: ReplayFile = JSON.parse(await readFile(file, 'utf8'));
  const md = [
    `# 重放报告 — ${dirname(file)}`,
    '',
    `判定规则：${'anyHit' in rep.verdictRule ? '命中 1 次即可复现' : '连续 3 次命中'}；原现场出事轮：${rep.incidentRound}`,
    '',
    '| 变体 | 结论 | 命中/轮 | 偏离点 |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.variant} | ${r.reproduced ? '能复现' : '未复现'} | ${r.hits}/${r.rounds} | ${r.firstDeviationRound !== undefined ? `第 ${r.firstDeviationRound} 轮起偏离` : '无偏离'} |`),
    '',
    `触发变体：${results.filter((r) => r.reproduced).map((r) => r.variant).join(', ') || '无'}`,
    '',
    ...results.flatMap((r) => r.hitDetails.slice(0, 5).map((h) => `- ${r.variant}: ${h}`)),
  ].join('\n');
  const out = join(dirname(file), 'replay-report.md');
  await writeFile(out, md);
  await writeFile(join(dirname(file), 'replay-report.json'), JSON.stringify(results, null, 2));
  console.log(`[replay] report → ${out}`);
  return results.some((r) => r.reproduced) ? 1 : 0;
}
