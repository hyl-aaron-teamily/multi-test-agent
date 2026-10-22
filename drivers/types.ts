// Black-box drivers: user-level input (touch / cursor / keyboard) by coordinates, user-visible
// observation (screen, process alive, system crash log, browser console). No page code injection.
import type { Surface } from '../platform/accounts/types';

export interface Point {
  x: number;
  y: number;
}

export type AnomalyKind = 'crash' | 'anr' | 'app-exit' | 'left-app' | 'app-error' | 'console-error' | 'page-error' | 'page-crash' | 'url-change';

export interface Anomaly {
  kind: AnomalyKind;
  at: number;
  detail: string;
  /** Suspicious only (e.g. an app E/ line): recorded, never a verdict on its own. */
  suspect?: boolean;
}

export interface Driver {
  readonly surface: Surface;
  /** Launch / open the app (once per plan unless the plan says each-iteration). */
  launch(): Promise<void>;
  tap(p: Point): Promise<void>;
  longPress(p: Point, ms?: number): Promise<void>;
  type(text: string): Promise<void>;
  key(name: string): Promise<void>;
  swipe(from: Point, to: Point, ms?: number): Promise<void>;
  scroll(at: Point, dy: number): Promise<void>;
  back(): Promise<void>;
  screenshot(): Promise<Buffer>;
  /** Anomalies seen since the last call (event-driven; draining costs nothing on the device). */
  drainAnomalies(): Anomaly[];
  close(): Promise<void>;
  /** Leave the app like a user (Home): it keeps running in the background. No left-app hit. */
  exitApp?(): Promise<void>;
  /** Kill the app's process (what swiping it away in recents does); verified gone. No app-exit hit. */
  killApp?(): Promise<void>;
  /** Reload the current page / window (F5); apps without a page reload = kill + launch. */
  reload?(): Promise<void>;
  /** Bring this surface to the front of a screen it shares with another surface (one phone: app + browser). */
  focus?(): Promise<void>;
  /** Another surface took the shared screen: leaving the foreground is expected, not a finding. */
  yieldFocus?(): void;
}

export type LifecycleOp = 'exitApp' | 'killApp' | 'reload';

/** Run a lifecycle op the surface supports natively; otherwise the nearest user-level equivalent. */
export async function lifecycle(d: Driver, op: LifecycleOp): Promise<void> {
  if (op === 'exitApp' || op === 'killApp') {
    const fn = d[op];
    if (!fn) throw new Error(`${d.surface}: ${op} not supported`);
    return fn.call(d);
  }
  if (d.reload) return d.reload();
  if (d.killApp) {
    await d.killApp();
    return d.launch();
  }
  throw new Error(`${d.surface}: reload not supported`);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
