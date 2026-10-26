// Executor (milestone 5 §C, split in W2-1): black-box, coordinate-driven. Orchestration only:
//   lease (account + endpoint slot) → session (launch once, sign in, home list, SKILL check)
//   → prepare (dynamic targets frozen, setup, precondition) → feature acceptance | [correct path] → loop
//   → verdict. Phases live in prepare.ts / phases.ts / loop.ts / checkpoint.ts / incident-hook.ts.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { modelCalls, setModelPurpose, visionConfigured } from '../core/model/llm';
import { profileKey, TEAMILY_PACKAGE } from '../drivers/factory';
import { sleep } from '../drivers/types';
import { AndroidFlightRecorder } from '../incident/android-recorder';
import type { EvidenceVerdict } from '../incident/evidence-review';
import { WebFlightRecorder } from '../incident/web-recorder';
import { loadIssueOf } from '../issue/paths';
import type { AccountPool, Lease } from '../platform/accounts/account-pool';
import { onAndroid, onPlaywright } from '../platform/accounts/types';
import type { DevicePool } from '../platform/device-pool';
import type { PlannedAction, TestPlan } from '../platform/schema/test-plan';
import { loadProfile, SkillStaleError } from '../skills/profile';
import type { NodeContext } from '../skills/teamily/nodes';
import { execAction } from './actions';
import { locate, locateTally } from './locate';
import { visionAsker } from './checks';
import type { RunCtx } from './context';
import { runLoop } from './loop';
import { runAcceptance, runCorrectPath } from './phases';
import { prepare } from './prepare';
import { closeSession, enterApp, openSession, type Session, staleShotPath } from './session';
import { newStats, type Stats } from './stats';
import { type FrozenTarget, visionLocator } from './targets';
import type { Conclusion } from './verdict';

export { execAction } from './actions';
export type { Stats } from './stats';

export interface RunOptions {
  plan: TestPlan;
  runDir: string;
  pool: AccountPool;
  devices?: DevicePool;
  udid?: string;
  headed?: boolean;
  maxSteps?: number;
  maxMinutes?: number;
  log?: (s: string) => void;
  taskId?: string;
  /** Check-based hits are reviewed against the Issue on their recorded evidence before they count
   *  (default: on when the Issue file exists and a vision model is configured). */
  evidenceReview?: boolean;
}

export interface RunResult {
  planId: string;
  issue: string;
  title: string;
  category: TestPlan['category'];
  surface: TestPlan['surface'];
  substitution?: TestPlan['substitution'];
  env: TestPlan['env'];
  /** Plan coverage of the contract's postcondition (report note when not covered). */
  coverage?: TestPlan['coverage'];
  /** Contract phenomenon (what a hit means). */
  phenomenon?: string;
  account?: string;
  device?: string;
  conclusion: Conclusion;
  conclusionDetail: string;
  startedAt: string;
  finishedAt: string;
  stats: Stats;
  hits: { round: number; step: number; at: string; reason: string; review?: EvidenceVerdict; reviewNote?: string }[];
  /** Check-based hits the evidence review rejected (frames do not show the Issue's phenomenon): not counted. */
  dismissed?: { round: number; step: number; reason: string; observed: string; incident: string }[];
  incidents: string[];
  targets: FrozenTarget[];
  acceptance?: { id: string; text: string; pass: boolean | null; detail: string; evidence?: string }[];
  roundLog: { round: number; step: number; results: { kind: string; pass: boolean | null; detail: string }[] }[];
  error?: string;
}

export async function runPlan(o: RunOptions): Promise<RunResult> {
  const plan = o.plan;
  const log = o.log ?? ((s) => console.log(`[run] ${s}`));
  await mkdir(o.runDir, { recursive: true });
  const t0 = Date.now();
  const stats = newStats();
  const calls0 = { ...modelCalls, byPurpose: { ...modelCalls.byPurpose } };
  const locate0 = JSON.parse(JSON.stringify(locateTally)) as typeof locateTally;
  const res: RunResult = { planId: plan.id, issue: plan.issueRef, title: plan.title, category: plan.category, surface: plan.surface, substitution: plan.substitution, env: plan.env, coverage: plan.coverage, phenomenon: plan.contract?.observable.phenomenon, conclusion: '执行失败', conclusionDetail: '', startedAt: new Date(t0).toISOString(), finishedAt: '', stats, hits: [], incidents: [], targets: [], roundLog: [] };
  const done = () => {
    stats.locateTiers = Object.fromEntries(Object.entries(locateTally).map(([k, v]) => [k, { n: v.n - (locate0[k]?.n ?? 0), ms: v.ms - (locate0[k]?.ms ?? 0) }]).filter(([, v]) => (v as { n: number }).n > 0));
    return finish(res, t0, stats, calls0);
  };

  // ---- lease: account + slot of an endpoint (a phone for Android surfaces, this computer otherwise)
  const taskId = o.taskId ?? `run-${plan.id}-${t0}`;
  let lease: Lease | null = null;
  for (let i = 0; i < 30 && !lease; i++) {
    lease = o.pool.lease(taskId, { env: plan.env, surface: plan.surface, accountId: plan.account, devices: o.devices, device: onAndroid(plan.surface) ? o.udid : undefined });
    if (!lease) await sleep(2000);
  }
  if (!lease) {
    res.error = `no free ${plan.env} account${o.devices ? ' / endpoint slot' : ''} for ${plan.surface}`;
    return done();
  }
  const account = lease.accounts[0];
  res.account = account.id;
  const udid = lease.device?.kind === 'android' ? lease.device.udid : (o.udid ?? (onAndroid(plan.surface) ? account.boundDevice : undefined));
  res.device = onAndroid(plan.surface) ? udid : undefined;

  let sess: Session | undefined;
  let afr: AndroidFlightRecorder | undefined;
  let wfr: WebFlightRecorder | undefined;
  const flightDir = join(o.runDir, '.flight');
  try {
    // ---- session: profile + driver + flight recorder, launch once, sign in, home list, SKILL check
    if (onPlaywright(plan.surface)) wfr = new WebFlightRecorder(flightDir);
    if (onAndroid(plan.surface) && udid) afr = new AndroidFlightRecorder(udid, loadProfile(profileKey(plan.surface, plan.env, udid))?.packageName ?? TEAMILY_PACKAGE, flightDir);
    sess = await openSession({ surface: plan.surface, env: plan.env, account: account.id, udid, pool: o.pool, headed: o.headed, onLog: afr?.onLog, onConsole: wfr?.onConsole, log });
    const s = sess;
    await afr?.start();
    await enterApp(s, {
      afterLaunch: async () => {
        if (s.web) await wfr!.start(s.web.context!, s.web.page!);
      },
      // Phones: the bottom bar looks the same on every tab — make sure the chat tab is the one showing.
      chatTab: plan.setup.some((a) => a.node?.name === 'teamily.openConversation'),
      staleShot: staleShotPath(o.runDir),
    });
    stats.launches++;

    const targets: Record<string, import('../drivers/types').Point> = {};
    const nodeCtx: NodeContext = {
      driver: s.d,
      profile: s.profile,
      targets,
      credentials: () => o.pool.backend.get(account.id),
      // prepare-only Nodes (validator keeps them out of the loop)
      locate: async (desc, texts) => (await locate(s.d, desc, { texts, purpose: 'prep' }))?.point ?? null,
    };
    const c: RunCtx = {
      plan,
      o,
      log,
      res,
      stats,
      sess: s,
      account: account.id,
      udid,
      t0,
      ask: await visionAsker(s.web ?? (s.inner as any)),
      locate: await visionLocator(s.web ?? (s.inner as any)),
      targets,
      exec: (a: PlannedAction) => execAction(a, nodeCtx, s.profile, targets),
      frames: [],
      setupOps: [],
      afr,
      wfr,
    };
    setModelPurpose('prep');
    await prepare(c);
    if (plan.category === 'feature') {
      setModelPurpose('acceptance');
      await runAcceptance(c);
      return done();
    }
    const correctPathOk = await runCorrectPath(c);
    setModelPurpose('checkpoint');
    const issue = o.evidenceReview === false || !visionConfigured() ? undefined : loadIssueOf(plan.issueRef);
    // Evidence review compares against the contract's phenomenon (W2-1 §5.6), else the Issue's actual result.
    const reviewIssue = issue && plan.contract ? { ...issue, actual: plan.contract.observable.phenomenon } : issue;
    await runLoop(c, { reviewIssue, correctPathOk });
    return done();
  } catch (err) {
    if (err instanceof SkillStaleError) {
      res.conclusion = 'SKILL 失效';
      res.conclusionDetail = err.message;
    }
    res.error = (err as Error).message.split('\n')[0];
    log(`error: ${res.error}`);
    return done();
  } finally {
    setModelPurpose('other');
    await afr?.stop().catch(() => {});
    if (sess?.web) await wfr?.stop(sess.web.context).catch(() => {});
    await closeSession(sess);
    o.pool.release(lease, o.devices);
  }
}

function finish(res: RunResult, t0: number, stats: Stats, calls0: typeof modelCalls): RunResult {
  res.finishedAt = new Date().toISOString();
  stats.durationSec = Math.round((Date.now() - t0) / 1000);
  stats.visionCalls = modelCalls.vision - calls0.vision;
  stats.textModelCalls = modelCalls.text - calls0.text;
  stats.modelCallsByPurpose = Object.fromEntries(Object.entries(modelCalls.byPurpose).map(([k, v]) => [k, v - (calls0.byPurpose[k] ?? 0)]).filter(([, v]) => (v as number) > 0));
  return res;
}

export const runDirFor = (planId: string) => resolve('midscene_run/issues', `${planId}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
