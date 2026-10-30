// Tree-read backends (W2-4 §4.1). Every Android hierarchy read goes through `readTree`:
//   A `uiautomator` — `uiautomator dump` to a file + `cat` (2.5–3.7 s on the test phone), serialised per device
//   B `a11y-service` — the on-device read-only accessibility service (registered by platform code when the
//     environment declares it); answers in uiautomator-compatible XML so parsing and verdicts are unchanged.
// A failing B falls back to A for that read; the fallback and its reason are counted (report: 读树后端).
import { adb } from './adb';

export type BackendName = 'uiautomator' | 'a11y-service';

export interface TreeRead {
  xml: string;
  backend: BackendName;
  t0: number;
  t1: number;
  /** Set when the preferred backend failed and this read fell back to uiautomator. */
  fallback?: string;
}

export interface TreeBackend {
  name: BackendName;
  /** Raw uiautomator-format XML of the current window(s). Throws when unavailable. */
  dump(udid: string | undefined, timeoutMs: number): Promise<string>;
}

const locks = new Map<string, Promise<unknown>>();
const seqs = new Map<string, number>();

export const uiautomatorBackend: TreeBackend = {
  name: 'uiautomator',
  dump(udid, timeoutMs) {
    // Concurrent dumps to one file returned each other's stale snapshots: serialise per device.
    const key = udid ?? '';
    const run = (locks.get(key) ?? Promise.resolve()).then(once, once);
    locks.set(key, run.catch(() => {}));
    return run;
    function once() {
      const n = (seqs.get(key) ?? 0) + 1;
      seqs.set(key, n);
      const f = `/sdcard/autotest_ui_${n % 4}.xml`;
      return adb(['shell', `rm -f ${f}; uiautomator dump ${f} >/dev/null 2>&1; cat ${f}`], udid, timeoutMs);
    }
  },
};

const preferred = new Map<string, TreeBackend>();

/** Select the backend for a device (undefined = back to uiautomator). */
export function setTreeBackend(udid: string | undefined, b: TreeBackend | undefined): void {
  if (b && b.name !== 'uiautomator') preferred.set(udid ?? '', b);
  else preferred.delete(udid ?? '');
}
export const treeBackendOf = (udid?: string): BackendName => preferred.get(udid ?? '')?.name ?? 'uiautomator';

/** Process-wide counters (merged into run reports). */
export const treeStats = { reads: {} as Record<string, { n: number; ms: number[] }>, fallbacks: [] as { at: string; udid: string; reason: string }[] };

function count(name: string, ms: number) {
  const r = (treeStats.reads[name] ??= { n: 0, ms: [] });
  r.n++;
  r.ms.push(ms);
  if (r.ms.length > 500) r.ms.shift();
}

/** One hierarchy read through the device's backend, falling back to uiautomator. */
export async function readTree(udid?: string, timeoutMs = 20_000): Promise<TreeRead> {
  const b = preferred.get(udid ?? '');
  let fallback: string | undefined;
  if (b) {
    const t0 = Date.now();
    try {
      const xml = await b.dump(udid, Math.min(timeoutMs, 5_000));
      if (!/<node\b/.test(xml)) throw new Error('empty hierarchy');
      const t1 = Date.now();
      count(b.name, t1 - t0);
      return { xml, backend: b.name, t0, t1 };
    } catch (e) {
      fallback = `${b.name}: ${(e as Error).message.split('\n')[0].slice(0, 160)}`;
      treeStats.fallbacks.push({ at: new Date().toISOString(), udid: udid ?? '', reason: fallback });
      if (treeStats.fallbacks.length > 100) treeStats.fallbacks.shift();
    }
  }
  const t0 = Date.now();
  const xml = await uiautomatorBackend.dump(udid, timeoutMs);
  const t1 = Date.now();
  count('uiautomator', t1 - t0);
  return { xml, backend: 'uiautomator', t0, t1, ...(fallback ? { fallback } : {}) };
}

/** Pure: p50 / p95 of a sample (ms). */
export function percentiles(ms: number[]): { n: number; p50: number; p95: number } {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : 0);
  return { n: s.length, p50: at(0.5), p95: at(0.95) };
}

/** Report lines: reads per backend with p50/p95, and fallbacks. Empty when nothing was read. */
export function treeReportLines(): string[] {
  const out: string[] = [];
  for (const [name, r] of Object.entries(treeStats.reads)) {
    const p = percentiles(r.ms);
    out.push(`- ${name}: ${r.n} 次，p50 ${p.p50} ms，p95 ${p.p95} ms`);
  }
  if (treeStats.fallbacks.length) {
    out.push(`- 退回 uiautomator ${treeStats.fallbacks.length} 次；首次原因：${treeStats.fallbacks[0].reason}`);
  }
  return out;
}
