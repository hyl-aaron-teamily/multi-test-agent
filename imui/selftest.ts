// Offline self-test (counterpart of im-loadtest selftest.py, which runs imload against a fake UC and
// gateway): two real browser pages on a local fake chat app, receive-side faults injected through
// the query string, and the full imui pipeline (WebClient → runner → metrics → SLO) must detect them.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { WebClient } from './clients/web';
import { runUiLoad } from './runner';
import { newRunId } from './tokens';

interface Case {
  name: string;
  query: string;
  expect: (r: ReturnType<Awaited<ReturnType<typeof runUiLoad>>['report']>, fails: string[]) => string | null;
}

const CASES: Case[] = [
  {
    name: 'clean',
    query: '',
    expect: (r, f) => (r.delivery.lost === 0 && r.duplicates === 0 && r.outOfOrder === 0 && !f.length ? null : `expected clean PASS, got ${JSON.stringify(f)}`),
  },
  {
    name: 'delay 800ms',
    query: 'delay=800',
    expect: (r, f) => ((r.ui_e2e_ms.p50 ?? 0) >= 750 && f.some((x) => x.includes('ui_e2e p99')) ? null : `e2e p50 ${r.ui_e2e_ms.p50} / ${JSON.stringify(f)}`),
  },
  { name: 'drop every 3rd', query: 'drop=3', expect: (r) => (r.delivery.lost === 2 ? null : `lost=${r.delivery.lost}, expected 2`) },
  { name: 'duplicate every 2nd', query: 'dup=2', expect: (r) => (r.duplicates === 3 ? null : `duplicates=${r.duplicates}, expected 3`) },
  { name: 'reorder', query: 'swap=1', expect: (r) => (r.outOfOrder >= 1 ? null : `outOfOrder=${r.outOfOrder}, expected >=1`) },
];

export async function selftest(): Promise<number> {
  const html = await readFile(resolve('imui/fixtures/fake-chat.html'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  let failed = 0;
  try {
    for (const c of CASES) {
      // Both "clients" share one browser context (BroadcastChannel needs the same origin + context).
      const a = new WebClient({ name: 'sender', appUrl: base });
      await a.open('Room A');
      const ctx = a.page!.context();
      const b = new WebClient({ name: 'observer', appUrl: `${base}?${c.query}` });
      // Reuse the sender's context for the observer page.
      const page = await ctx.newPage();
      Object.assign(b, { page });
      await page.exposeBinding('__imuiSeen', (_s, tokens: string[], at: number) => {
        for (const t of tokens) (b as unknown as { onSeen?: (t: string, at: number) => void }).onSeen?.(t, at);
      });
      await page.goto(`${base}?${c.query}`);
      await b.open('Room A');
      const m = await runUiLoad(
        { runId: newRunId(), senders: [a], clients: [a, b], observersFor: () => [b.id], durationSec: 30, rate: 2, rampSec: 0, drainSec: 2, msgTypes: ['text'], payloadBytes: 0, maxMessages: 6 },
        () => {},
      );
      const r = m.report();
      const err = c.expect(r, m.checkSlo({ e2eP99Ms: 500, maxLossRatio: 0 }));
      console.log(`${err ? '✗' : '✓'} ${c.name.padEnd(20)} sent=${r.messagesSent} lost=${r.delivery.lost} dup=${r.duplicates} ooo=${r.outOfOrder} e2e p50=${r.ui_e2e_ms.p50}ms echo p50=${r.ui_echo_ms.p50}ms${err ? `  ← ${err}` : ''}`);
      if (err) failed++;
      await a.close();
    }
  } finally {
    server.close();
  }
  console.log(failed ? `\nselftest: ${failed}/${CASES.length} FAILED` : `\nselftest: ${CASES.length}/${CASES.length} passed`);
  return failed ? 1 : 0;
}
