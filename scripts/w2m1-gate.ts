// W2-1 P3 acceptance helpers (not a product entry): run a plan against a MODIFIED COPY of a profile
// (the calibrated profile file is never written).
//   tsx scripts/w2m1-gate.ts broken  --surface desktop-web   → warm-up must stop the plan (计划不可执行)
//   tsx scripts/w2m1-gate.ts heal    --surface android-app   → chatlist.search moved 150 px up (blank title bar); fingerprint heals it
import 'dotenv/config';
import { profileKey } from '../drivers/factory';
import { runDirFor, runPlan } from '../executor/run';
import type { Surface, TestPlan } from '../platform/schema/test-plan';
import { openPools } from '../platform/pools';
import { loadProfile } from '../skills/profile';
import { SKILL_VERSION } from '../skills/teamily/vocab';

const mode = process.argv[2];
const surface = (process.argv[process.argv.indexOf('--surface') + 1] ?? 'desktop-web') as Surface;
const { pool, devices } = await openPools();
const udid = surface.startsWith('android') ? (await devices.refresh()).find((x) => x.kind === 'android')?.udid : undefined;
const profile = structuredClone(loadProfile(profileKey(surface, 'prod', udid))!);
// Broken: nav.me moved into the empty middle of the left navigation rail (nothing to tap there).
if (mode === 'broken') profile.elements['nav.me'] = { ...profile.elements['nav.me'], box: [profile.elements['nav.me'].box[0], Math.round(profile.viewport.height * 0.58), 10, 10] };
else if (!surface.startsWith('android')) {
  // Web: nav.chat moved into the empty middle of the page (tapping there changes nothing).
  const b = profile.elements['nav.chat'].box;
  profile.elements['nav.chat'] = { ...profile.elements['nav.chat'], box: [Math.round(profile.viewport.width * 0.6), Math.round(profile.viewport.height * 0.5), b[2], b[3]] };
} else {
  const b = profile.elements['chatlist.search'].box;
  profile.elements['chatlist.search'] = { ...profile.elements['chatlist.search'], box: [b[0], b[1] - 150, b[2], b[3]] };
}
const id = `w2m1-${mode}-${surface}`;
const plan: TestPlan = {
  id,
  issueRef: 'w2m1-gate',
  title: mode === 'broken' ? '不可执行计划：nav.me 坐标错位（临时 profile 副本）' : '自愈：chatlist.search 上移 150 px（临时 profile 副本）',
  category: 'bug-intermittent',
  surface,
  issueSurfaces: [],
  env: 'prod',
  launch: 'once',
  targets: [],
  setup: [],
  prepare: [],
  actions: mode === 'broken' || !surface.startsWith('android') ? [{ type: 'tap', element: 'nav.me', delayAfterMs: 1000 }, { type: 'tap', element: 'nav.chat', delayAfterMs: 1000 }] : [{ type: 'tap', element: 'chatlist.search', delayAfterMs: 1000 }, { type: 'back', delayAfterMs: 1000 }, { type: 'back', delayAfterMs: 1000 }],
  checks: [{ kind: 'crash', expect: 'no crash', want: 'absent' }],
  afterCheck: [],
  limits: { maxSteps: 6, maxMinutes: 5, maxIntervalMs: 1000 },
  verdictRule: { anyHit: true },
  provenance: { generatedBy: 'manual', skillVersion: SKILL_VERSION },
};
const r = await runPlan({ plan, runDir: runDirFor(id), pool, devices, udid, profile });
console.log(`[gate] ${mode}: ${r.conclusion} — ${r.conclusionDetail}${r.error ? ` (error ${r.error})` : ''}; healed ${JSON.stringify(r.healed ?? [])}; warm-up ${JSON.stringify(r.warmup?.steps.map((s) => [s.step, s.action, s.pass, s.observed, s.healed]))}`);
