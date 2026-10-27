// Records every primitive driver operation (coordinates, timing) — the source of replay.json and ops.srt.
import { type Anomaly, type Driver, type LifecycleOp, lifecycle, type Point, sleep } from '../drivers/types';

export interface CoordOp {
  /** Global step number (1-based) the op belongs to. */
  step: number;
  round: number;
  /** Host time the op started (ms). */
  at: number;
  durationMs: number;
  op: 'tap' | 'longPress' | 'type' | 'key' | 'swipe' | 'scroll' | 'back' | 'launch' | 'wait' | 'idle' | 'focus' | LifecycleOp;
  point?: Point;
  to?: Point;
  value?: string;
  ms?: number;
  /** Plan-level label: element id / node name. */
  label?: string;
}

export class RecordingDriver implements Driver {
  readonly ops: CoordOp[] = [];
  step = 0;
  round = 0;
  label = '';
  /** Values never written to ops (credentials). */
  private secret = false;

  constructor(readonly inner: Driver) {}

  get surface() {
    return this.inner.surface;
  }

  /** Run `fn` with typed text redacted from the op log. */
  async redacted<T>(fn: () => Promise<T>): Promise<T> {
    this.secret = true;
    try {
      return await fn();
    } finally {
      this.secret = false;
    }
  }

  private async rec<T>(op: CoordOp['op'], extra: Partial<CoordOp>, fn: () => Promise<T>): Promise<T> {
    const at = Date.now();
    try {
      return await fn();
    } finally {
      this.ops.push({ step: this.step, round: this.round, at, durationMs: Date.now() - at, op, label: this.label, ...extra });
      if (this.ops.length > 20_000) this.ops.splice(0, 5_000);
    }
  }

  launch() {
    return this.rec('launch', {}, () => this.inner.launch());
  }
  tap(p: Point) {
    return this.rec('tap', { point: p }, () => this.inner.tap(p));
  }
  longPress(p: Point, ms?: number) {
    return this.rec('longPress', { point: p, ms }, () => this.inner.longPress(p, ms));
  }
  type(text: string) {
    return this.rec('type', { value: this.secret ? '<redacted>' : text }, () => this.inner.type(text));
  }
  key(name: string) {
    return this.rec('key', { value: name }, () => this.inner.key(name));
  }
  swipe(from: Point, to: Point, ms?: number) {
    return this.rec('swipe', { point: from, to, ms }, () => this.inner.swipe(from, to, ms));
  }
  scroll(at: Point, dy: number) {
    return this.rec('scroll', { point: at, ms: dy }, () => this.inner.scroll(at, dy));
  }
  back() {
    return this.rec('back', {}, () => this.inner.back());
  }
  exitApp() {
    return this.rec('exitApp', {}, () => lifecycle(this.inner, 'exitApp'));
  }
  killApp() {
    return this.rec('killApp', {}, () => lifecycle(this.inner, 'killApp'));
  }
  reload() {
    return this.rec('reload', {}, () => lifecycle(this.inner, 'reload'));
  }
  focus() {
    return this.rec('focus', {}, async () => this.inner.focus?.());
  }
  keyboardShown() {
    return this.inner.keyboardShown ? this.inner.keyboardShown() : Promise.resolve(null);
  }

  yieldFocus() {
    this.inner.yieldFocus?.();
  }
  /** No input for `ms` (app in the background, waiting for a reload). Not an action interval. */
  idle(ms: number) {
    return this.rec('idle', { ms }, () => sleep(ms));
  }
  screenshot() {
    return this.inner.screenshot();
  }
  drainAnomalies(): Anomaly[] {
    return this.inner.drainAnomalies();
  }
  close() {
    return this.inner.close();
  }
}
