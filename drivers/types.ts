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
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
