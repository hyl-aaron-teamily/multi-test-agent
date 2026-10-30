// State shared by the phases of one plan run (prepare → [warm-up] → loop / acceptance → verdict).
import type { Point } from '../drivers/types';
import type { AndroidFlightRecorder } from '../incident/android-recorder';
import type { RoundFrame } from '../incident/bundle';
import type { CoordOp } from '../incident/recording-driver';
import type { WebFlightRecorder } from '../incident/web-recorder';
import type { PlannedAction, TestPlan } from '../platform/schema/test-plan';
import type { VisionAsk } from './checks';
import type { RunOptions, RunResult } from './run';
import type { Session } from './session';
import type { Stats } from './stats';

export interface RunCtx {
  plan: TestPlan;
  o: RunOptions;
  log: (s: string) => void;
  res: RunResult;
  stats: Stats;
  sess: Session;
  account: string;
  udid?: string;
  t0: number;
  ask?: VisionAsk;
  locate?: (q: string) => Promise<Point | null>;
  /** Frozen targets: id → point. */
  targets: Record<string, Point>;
  exec: (a: PlannedAction) => Promise<void>;
  frames: RoundFrame[];
  setupOps: CoordOp[];
  afr?: AndroidFlightRecorder;
  wfr?: WebFlightRecorder;
  /** Pre-tap check (on during preparation / re-entry only). */
  guard?: import('./pretap').PreTapGuard;
}
