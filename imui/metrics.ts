// UI-level message metrics, ported from im-loadtest imload/metrics.py and moved one layer up:
//   imload send_ack_ms   (1003 reply)          → ui_echo_ms : send tapped → own bubble visible
//   imload end_to_end_ms (2001 push)           → ui_e2e_ms  : send tapped → bubble visible on an observer
//   imload ws_connect_ms                       → ui_ready_ms: client opened + conversation ready
// Same percentile interpolation, per-type breakdown, delivery counted per observer client (not per
// user) and SLO rules. Added on top of imload: duplicate bubbles and out-of-order display, which
// imload explicitly does not count (it only de-duplicates pushes).
// All timestamps are host epoch ms from one machine (browser Date.now shares the host clock), so
// there is no cross-device skew; Android observation has a polling resolution, reported separately.

export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const o = [...values].sort((a, b) => a - b);
  if (o.length === 1) return o[0];
  const rank = (o.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return lo === hi ? o[lo] : o[lo] + (o[hi] - o[lo]) * (rank - lo);
}

export interface SeriesSummary {
  count: number;
  min?: number;
  p50?: number;
  p90?: number;
  p95?: number;
  p99?: number;
  max?: number;
  avg?: number;
}

export class Series {
  readonly values: number[] = [];
  add(v: number): void {
    this.values.push(v);
  }
  summary(): SeriesSummary {
    const v = this.values;
    if (!v.length) return { count: 0 };
    const r = (x: number) => Math.round(x * 10) / 10;
    return {
      count: v.length,
      min: r(Math.min(...v)),
      p50: r(percentile(v, 0.5)),
      p90: r(percentile(v, 0.9)),
      p95: r(percentile(v, 0.95)),
      p99: r(percentile(v, 0.99)),
      max: r(Math.max(...v)),
      avg: r(v.reduce((a, b) => a + b, 0) / v.length),
    };
  }
}

interface InFlight {
  token: string;
  seq: number;
  sender: string;
  msgType: string;
  sentAt: number;
  expected: Set<string>; // observer client ids (not including the sender's own echo)
  echoAt?: number;
  receivedBy: Map<string, number>;
}

export interface Slo {
  e2eP99Ms?: number;
  echoP99Ms?: number;
  maxLossRatio?: number;
  maxDuplicates?: number;
  maxOutOfOrder?: number;
}

export class UiMetrics {
  private readonly inFlight = new Map<string, InFlight>();
  private readonly discarded = new Set<string>();
  readonly e2e = new Series();
  readonly echo = new Series();
  readonly ready = new Series();
  private readonly perType = new Map<string, { e2e: Series; echo: Series }>();
  /** Per observer: tokens in first-seen order (for ordering checks). */
  private readonly seenOrder = new Map<string, number[]>();
  readonly sendErrors = new Map<string, number>();
  readonly clientErrors = new Map<string, number>();
  /** Bubbles counted more than once for the same token on one client. */
  duplicates = 0;
  /** Token text seen that this run never sent (stale run, typo, other tester). */
  unexpected = 0;
  sent = 0;
  wallSeconds = 0;

  private stats(t: string) {
    if (!this.perType.has(t)) this.perType.set(t, { e2e: new Series(), echo: new Series() });
    return this.perType.get(t)!;
  }

  /** Register before the send completes (like imload: registered before awaiting the ACK). */
  registerSend(token: string, seq: number, sender: string, msgType: string, sentAt: number, observers: string[]): void {
    this.inFlight.set(token, { token, seq, sender, msgType, sentAt, expected: new Set(observers), receivedBy: new Map() });
    this.sent++;
  }

  /** A send that never left the UI (input/tap failed): not counted as sent nor lost. */
  discard(token: string, reason: string): void {
    if (this.inFlight.delete(token)) this.sent--;
    this.discarded.add(token);
    this.sendErrors.set(reason, (this.sendErrors.get(reason) ?? 0) + 1);
  }

  /** `client` saw `token` rendered at `at`. Same client = echo, other client = delivery. */
  seen(client: string, token: string, at: number): void {
    const e = this.inFlight.get(token);
    if (!e) {
      if (!this.discarded.has(token)) this.unexpected++;
      return;
    }
    if (client === e.sender) {
      if (e.echoAt === undefined) {
        e.echoAt = at;
        this.echo.add(Math.max(0, at - e.sentAt));
        this.stats(e.msgType).echo.add(Math.max(0, at - e.sentAt));
      }
      return;
    }
    if (e.receivedBy.has(client)) return;
    e.receivedBy.set(client, at);
    this.e2e.add(Math.max(0, at - e.sentAt));
    this.stats(e.msgType).e2e.add(Math.max(0, at - e.sentAt));
    if (!this.seenOrder.has(client)) this.seenOrder.set(client, []);
    this.seenOrder.get(client)!.push(e.seq);
  }

  countDuplicates(n: number): void {
    this.duplicates += n;
  }

  clientError(client: string): void {
    this.clientErrors.set(client, (this.clientErrors.get(client) ?? 0) + 1);
  }

  /** Inversions in first-seen order per observer (0 = strictly in send order). Pure over state. */
  outOfOrder(): number {
    let n = 0;
    for (const seqs of this.seenOrder.values()) for (let i = 1; i < seqs.length; i++) if (seqs[i] < seqs[i - 1]) n++;
    return n;
  }

  delivery(msgType?: string) {
    let expected = 0;
    let delivered = 0;
    for (const e of this.inFlight.values()) {
      if (msgType && e.msgType !== msgType) continue;
      expected += e.expected.size;
      for (const c of e.expected) if (e.receivedBy.has(c)) delivered++;
    }
    const lost = expected - delivered;
    return { expected, delivered, lost, lossRatio: expected ? lost / expected : 0 };
  }

  /** Sends whose own bubble never showed up on the sender (UI echo missing). */
  echoMissing(): string[] {
    return [...this.inFlight.values()].filter((e) => e.echoAt === undefined).map((e) => e.token);
  }

  lostTokens(): { token: string; missingOn: string[] }[] {
    return [...this.inFlight.values()]
      .map((e) => ({ token: e.token, missingOn: [...e.expected].filter((c) => !e.receivedBy.has(c)) }))
      .filter((x) => x.missingOn.length);
  }

  report() {
    return {
      wallSeconds: Math.round(this.wallSeconds * 1000) / 1000,
      messagesSent: this.sent,
      sendRatePerSec: this.wallSeconds ? Math.round((this.sent / this.wallSeconds) * 100) / 100 : 0,
      delivery: this.delivery(),
      byMsgType: Object.fromEntries(
        [...this.perType].sort().map(([t, s]) => [t, { ui_echo_ms: s.echo.summary(), ui_e2e_ms: s.e2e.summary(), delivery: this.delivery(t) }]),
      ),
      ui_ready_ms: this.ready.summary(),
      ui_echo_ms: this.echo.summary(),
      ui_e2e_ms: this.e2e.summary(),
      echoMissing: this.echoMissing().length,
      duplicates: this.duplicates,
      outOfOrder: this.outOfOrder(),
      unexpected: this.unexpected,
      sendErrors: Object.fromEntries(this.sendErrors),
      clientErrors: Object.fromEntries(this.clientErrors),
    };
  }

  /** imload check_slo rules, plus UI-only ones. Empty = pass. No SLO configured → only hard failures. */
  checkSlo(slo: Slo): string[] {
    const f: string[] = [];
    const e2e = this.e2e.summary();
    const echo = this.echo.summary();
    const loss = this.delivery();
    if (slo.e2eP99Ms !== undefined && e2e.count && e2e.p99! > slo.e2eP99Ms) f.push(`ui_e2e p99 ${e2e.p99}ms > SLO ${slo.e2eP99Ms}ms`);
    if (slo.echoP99Ms !== undefined && echo.count && echo.p99! > slo.echoP99Ms) f.push(`ui_echo p99 ${echo.p99}ms > SLO ${slo.echoP99Ms}ms`);
    if (slo.maxLossRatio !== undefined && loss.lossRatio > slo.maxLossRatio) f.push(`loss ratio ${loss.lossRatio.toFixed(4)} > SLO ${slo.maxLossRatio}`);
    if (this.duplicates > (slo.maxDuplicates ?? 0)) f.push(`duplicate bubbles: ${this.duplicates}`);
    if (this.outOfOrder() > (slo.maxOutOfOrder ?? 0)) f.push(`out-of-order display: ${this.outOfOrder()}`);
    if (this.echoMissing().length) f.push(`own bubble never shown for ${this.echoMissing().length} sent message(s)`);
    if (this.sendErrors.size) f.push(`send errors: ${JSON.stringify(Object.fromEntries(this.sendErrors))}`);
    if (this.clientErrors.size) f.push(`client errors: ${JSON.stringify(Object.fromEntries(this.clientErrors))}`);
    return f;
  }
}
