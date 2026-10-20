// imui run loop, shaped like imload runner.run(): ramp → steady sends at `rate` per sender for
// `duration` → drain (wait for late deliveries) → final duplicate scan → metrics.
// UI sends are serialised per sender client (one composer); different senders run concurrently.
import type { UiClient } from './clients/types';
import { UiMetrics } from './metrics';
import { makeToken, messageBody } from './tokens';

export interface RunPlan {
  runId: string;
  senders: UiClient[];
  /** Every client watches; observers are the ones whose sightings count as delivery. */
  clients: UiClient[];
  observersFor: (sender: UiClient) => string[];
  durationSec: number;
  /** Messages per second per sender. */
  rate: number;
  rampSec: number;
  drainSec: number;
  msgTypes: string[];
  payloadBytes: number;
  /** Hard cap on messages per run (safety). */
  maxMessages: number;
  shouldStop?: () => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runUiLoad(plan: RunPlan, log: (s: string) => void = console.log): Promise<UiMetrics> {
  const m = new UiMetrics();
  for (const c of plan.clients) c.startWatch(plan.runId, (token, at) => m.seen(c.id, token, at));
  const t0 = Date.now();
  let seq = 0;
  let budget = plan.maxMessages;

  const senderLoop = async (s: UiClient) => {
    const end = t0 + plan.durationSec * 1000;
    let i = 0;
    while (Date.now() < end && budget > 0 && !plan.shouldStop?.()) {
      const elapsed = (Date.now() - t0) / 1000;
      // Linear ramp from 10% to 100% of the target rate (imload --ramp).
      const factor = plan.rampSec > 0 && elapsed < plan.rampSec ? Math.max(0.1, elapsed / plan.rampSec) : 1;
      const interval = 1000 / (plan.rate * factor);
      const started = Date.now();
      const msgType = plan.msgTypes[i++ % plan.msgTypes.length];
      const mySeq = ++seq;
      budget--;
      const token = makeToken(plan.runId, mySeq);
      // Registered before the send completes, like imload (send time = press of the send button).
      m.registerSend(token, mySeq, s.id, msgType, Date.now(), plan.observersFor(s));
      try {
        const pressedAt = await s.send(messageBody(token, msgType, plan.payloadBytes));
        m.markPressed(token, pressedAt);
        log(`[imui] ${s.id} → ${token} (${msgType})`);
      } catch (err) {
        m.discard(token, `${s.id}: ${(err as Error).message.split('\n')[0].slice(0, 80)}`);
        log(`[imui] ${s.id} send failed: ${(err as Error).message.split('\n')[0]}`);
        await sleep(2_000);
      }
      await sleep(Math.max(0, interval - (Date.now() - started)));
    }
  };

  await Promise.all(plan.senders.map(senderLoop));
  const sendWall = (Date.now() - t0) / 1000;
  log(`[imui] sending done (${m.sent} sent), draining ${plan.drainSec}s`);
  await sleep(plan.drainSec * 1000);
  for (const c of plan.clients) {
    await c.stopWatch();
    const d = await c.duplicates(plan.runId).catch(() => 0);
    if (d) log(`[imui] ${c.id}: ${d} duplicate bubble(s)`);
    m.countDuplicates(d);
  }
  m.wallSeconds = sendWall;
  return m;
}
