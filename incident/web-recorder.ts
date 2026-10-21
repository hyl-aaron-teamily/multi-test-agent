// Web flight recorder: Playwright tracing in chunks (startChunk/stopChunk, newest N kept) with screenshots,
// actions and network; console + request/response kept in in-memory rings; page video (recordVideo) for
// frame-hash deviation checks at replay. No page code is injected.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';

export const WEB_WINDOW_MS = 180_000;

interface NetEntry {
  at: number;
  method: string;
  url: string;
  status?: number;
  ms?: number;
  failure?: string;
  resourceType: string;
}

export class WebFlightRecorder {
  private chunks: { file: string; startedAt: number; endedAt: number }[] = [];
  private chunkStart = 0;
  private k = 0;
  readonly console: { at: number; type: string; text: string }[] = [];
  private net: NetEntry[] = [];
  private started = false;

  constructor(
    private readonly workDir: string,
    private readonly keep = 4,
  ) {}

  onConsole = (e: { at: number; type: string; text: string }): void => {
    this.console.push(e);
    if (this.console.length > 3000) this.console.splice(0, 1000);
  };

  async start(context: BrowserContext, page: Page): Promise<void> {
    await mkdir(this.workDir, { recursive: true });
    page.on('request', (r) => {
      this.net.push({ at: Date.now(), method: r.method(), url: r.url().slice(0, 500), resourceType: r.resourceType() });
      if (this.net.length > 5000) this.net.splice(0, 1500);
    });
    page.on('requestfinished', async (r) => {
      const e = [...this.net].reverse().find((x) => x.url === r.url().slice(0, 500) && x.status === undefined);
      if (!e) return;
      const resp = await r.response().catch(() => null);
      e.status = resp?.status();
      e.ms = Date.now() - e.at;
    });
    page.on('requestfailed', (r) => {
      const e = [...this.net].reverse().find((x) => x.url === r.url().slice(0, 500) && x.status === undefined);
      if (e) e.failure = r.failure()?.errorText ?? 'failed';
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    await context.tracing.startChunk({ title: 'chunk-0' });
    this.chunkStart = Date.now();
    this.started = true;
  }

  /** Rotate the trace chunk (call between rounds when the chunk is older than `maxMs`). */
  async rotate(context: BrowserContext, maxMs = 45_000): Promise<void> {
    if (!this.started || Date.now() - this.chunkStart < maxMs) return;
    const file = join(this.workDir, `trace-chunk-${this.k++ % (this.keep + 1)}.zip`);
    await context.tracing.stopChunk({ path: file });
    this.chunks.push({ file, startedAt: this.chunkStart, endedAt: Date.now() });
    while (this.chunks.length > this.keep) this.chunks.shift();
    await context.tracing.startChunk({ title: `chunk-${this.k}` });
    this.chunkStart = Date.now();
  }

  async capture(context: BrowserContext, dir: string, at: number): Promise<{ traces: { name: string; startedAt: number; endedAt: number }[]; logFrom: number; logTo: number }> {
    await mkdir(join(dir, 'trace'), { recursive: true });
    await mkdir(join(dir, 'logs'), { recursive: true });
    const cur = join(this.workDir, `trace-chunk-${this.k++ % (this.keep + 1)}.zip`);
    await context.tracing.stopChunk({ path: cur });
    this.chunks.push({ file: cur, startedAt: this.chunkStart, endedAt: Date.now() });
    while (this.chunks.length > this.keep) this.chunks.shift();
    await context.tracing.startChunk({ title: `chunk-${this.k}` });
    this.chunkStart = Date.now();
    const traces: { name: string; startedAt: number; endedAt: number }[] = [];
    for (const [i, c] of this.chunks.entries()) {
      if (c.endedAt < at - WEB_WINDOW_MS || !existsSync(c.file)) continue;
      const name = `trace-chunk-${i + 1}.zip`;
      await copyFile(c.file, join(dir, 'trace', name));
      traces.push({ name, startedAt: c.startedAt, endedAt: c.endedAt });
    }
    const logFrom = at - WEB_WINDOW_MS;
    const logTo = Date.now();
    await writeFile(join(dir, 'logs', 'console.jsonl'), this.console.filter((c) => c.at >= logFrom).map((c) => JSON.stringify({ ...c, time: new Date(c.at).toISOString() })).join('\n'));
    const entries = this.net
      .filter((n) => n.at >= logFrom)
      .map((n) => ({
        startedDateTime: new Date(n.at).toISOString(),
        time: n.ms ?? -1,
        request: { method: n.method, url: n.url, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
        response: { status: n.status ?? 0, statusText: n.failure ?? '', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: -1, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
        cache: {},
        timings: { send: 0, wait: n.ms ?? -1, receive: 0 },
        _resourceType: n.resourceType,
      }));
    await writeFile(join(dir, 'logs', 'network.har'), JSON.stringify({ log: { version: '1.2', creator: { name: 'autotest web flight recorder', version: '1' }, entries } }, null, 1));
    return { traces, logFrom, logTo };
  }

  async stop(context?: BrowserContext): Promise<void> {
    if (this.started) await context?.tracing.stop().catch(() => {});
    this.started = false;
    await rm(this.workDir, { recursive: true, force: true }).catch(() => {});
  }
}
