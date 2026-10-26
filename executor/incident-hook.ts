// Incident bundle of the current run: flight-recorder capture + coordinate replay file + bundle.
import { type IncidentKind, incidentDir, type ReplayFile, writeIncident } from '../incident/bundle';
import type { CoordOp } from '../incident/recording-driver';
import type { RunCtx } from './context';

export async function recordIncident(c: RunCtx, kind: IncidentKind, detail: string, round: number): Promise<string> {
  const { d, profile, web } = c.sess;
  const n = c.res.incidents.length + 1;
  const dir = incidentDir(c.o.runDir, n, kind);
  const at = Date.now();
  c.log(`incident ${n}-${kind} → ${dir}`);
  const cap = c.afr ? await c.afr.capture(dir, at) : c.wfr && web ? await c.wfr.capture(web.context!, dir, at) : undefined;
  const fromRound = Math.max(1, round - 20);
  const rounds: ReplayFile['rounds'] = [];
  for (let r = fromRound; r <= round; r++) rounds.push({ round: r, ops: d.ops.filter((x: CoordOp) => x.round === r && x.op !== 'launch'), endHash: c.frames.find((f) => f.round === r)?.hash });
  const replay: ReplayFile = {
    format: 'coord-v1',
    skillVersion: profile.skillVersion,
    surface: c.plan.surface,
    profile: profile.name,
    env: c.plan.env,
    url: web ? c.o.pool.webUrl(c.plan.env) : undefined,
    packageName: profile.packageName,
    account: c.account,
    device: c.udid,
    launch: c.plan.launch,
    category: c.plan.category,
    verdictRule: c.plan.verdictRule,
    checks: c.plan.checks,
    targets: c.res.targets.map((t) => ({ id: t.id, point: t.point, chosen: t.chosen })),
    setupOps: c.setupOps,
    rounds,
    incidentRound: round,
  };
  await writeIncident({
    runDir: c.o.runDir,
    n,
    kind,
    at,
    detail,
    plan: c.plan,
    step: c.stats.steps,
    round,
    action: d.label,
    env: { account: c.account, device: c.udid, ...(cap && 'state' in cap ? cap.state : {}), browser: web ? `chromium ${web.browser?.version() ?? ''}` : undefined },
    ops: d.ops,
    frames: c.frames,
    replay,
    videos: cap && 'videos' in cap ? cap.videos : undefined,
    traces: cap && 'traces' in cap ? cap.traces : undefined,
    logFrom: cap?.logFrom ?? at - 180_000,
    logTo: cap?.logTo ?? at,
    clockOffsetMs: c.afr?.clockOffsetMs,
    dir,
  });
  return dir;
}
