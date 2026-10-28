// Raw run trajectory (W2-1 §7): `trajectory-v1`, one JSON event per line in <runDir>/trajectory.jsonl.
// Sinks never throw into a test run: every failure is swallowed and warned once; the queue is bounded
// (op events are dropped first and counted). No credentials, no images (relative paths only).
// Fields map 1:1 onto TencentDB Agent Memory `/v3/session/add` (TdaiSessionSink, optional, off by default).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type TrajectoryKind = 'manifest' | 'contract' | 'plan' | 'lease' | 'prep.target' | 'warmup.step' | 'op' | 'observe' | 'locate' | 'model-call' | 'hit' | 'dismissed' | 'incident' | 'healed' | 'verdict';

export interface TrajectoryEvent {
  t: string;
  kind: TrajectoryKind;
  [k: string]: unknown;
}

export interface TrajectorySummary {
  runId: string;
  /** Issue id + title + sub-case (TDAI user_query). */
  query: string;
  startedAt: string;
  endedAt: string;
  model: string;
  /** Pool account id (never credentials) — TDAI x-tdai-user-id. */
  account: string;
  output: Record<string, unknown>;
}

export interface TrajectorySink {
  emit(e: TrajectoryEvent): void;
  close(summary: TrajectorySummary): Promise<void>;
}

const MAX_EVENTS = 20_000;
const SECRET_KEYS = /password|passwd|secret|token|apikey|api_key|credential/i;

/** Pure: drop credential-looking fields (defence in depth; events never carry credentials). */
export function scrub<T>(v: T): T {
  if (Array.isArray(v)) return v.map(scrub) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as object).filter(([k]) => !SECRET_KEYS.test(k)).map(([k, x]) => [k, Buffer.isBuffer(x) ? '[binary]' : scrub(x)])) as T;
  return v;
}

/** Collects events, writes them to a JSONL file and forwards the whole run to extra sinks on close. */
export class Trajectory {
  readonly events: TrajectoryEvent[] = [];
  dropped = 0;
  private warned = false;

  constructor(
    readonly file: string,
    private readonly extra: TrajectorySink[] = [],
  ) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch (e) {
      this.warn(e);
    }
  }

  emit(kind: TrajectoryKind, data: Record<string, unknown> = {}): void {
    try {
      if (this.events.length >= MAX_EVENTS) {
        // Bounded: drop op events first.
        const i = this.events.findIndex((x) => x.kind === 'op');
        if (kind === 'op' || i < 0) {
          this.dropped++;
          return;
        }
        this.events.splice(i, 1);
        this.dropped++;
      }
      // The event kind always wins over a data field of the same name.
      const e = scrub({ t: new Date().toISOString(), ...data, kind }) as TrajectoryEvent;
      this.events.push(e);
      appendFileSync(this.file, `${JSON.stringify(e)}\n`);
      for (const s of this.extra) s.emit(e);
    } catch (err) {
      this.warn(err);
    }
  }

  async close(summary: TrajectorySummary): Promise<void> {
    for (const s of this.extra) await s.close(scrub(summary)).catch((e) => this.warn(e));
  }

  private warn(e: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[trajectory] recording problem (run continues): ${(e as Error)?.message ?? e}`);
  }
}

/** TencentDB Agent Memory (standalone gateway) `/v3/session/add`: one request on close, 3 s timeout,
 *  no retry (a retry after a timeout could write a duplicate record). Enabled by TRAJECTORY_TDAI_URL. */
export class TdaiSessionSink implements TrajectorySink {
  private readonly events: TrajectoryEvent[] = [];
  lastStatus?: number;

  constructor(
    readonly url: string,
    readonly timeoutMs = 3000,
  ) {}

  emit(e: TrajectoryEvent): void {
    this.events.push(e);
  }

  /** Pure: request of a run (headers + body) for /v3/session/add. */
  request(s: TrajectorySummary): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    return {
      url: `${this.url.replace(/\/$/, '')}/v3/session/add`,
      headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'multi-test-agent', 'x-tdai-user-id': s.account || 'unknown', 'x-tdai-session-id': s.runId },
      body: { source: 'offline', started_at: s.startedAt, ended_at: s.endedAt, user_query: s.query, model: s.model || 'none', messages: this.events.length ? this.events : [{ kind: 'empty' }], output: s.output },
    };
  }

  async close(s: TrajectorySummary): Promise<void> {
    const r = this.request(s);
    try {
      const res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal: AbortSignal.timeout(this.timeoutMs) });
      this.lastStatus = res.status;
      if (!res.ok) console.warn(`[trajectory] TDAI session/add HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      console.warn(`[trajectory] TDAI gateway unreachable (run unaffected): ${(e as Error).message}`);
    }
  }
}

/** The sinks configured for this process (JSONL always; TDAI when TRAJECTORY_TDAI_URL is set). */
export function openTrajectory(file: string): Trajectory {
  const extra: TrajectorySink[] = process.env.TRAJECTORY_TDAI_URL ? [new TdaiSessionSink(process.env.TRAJECTORY_TDAI_URL)] : [];
  return new Trajectory(file, extra);
}

/** ISO timestamp in TDAI's exact format YYYY-MM-DDTHH:MM:SS.sssZ. */
export const isoMs = (t: number | string) => new Date(t).toISOString();
