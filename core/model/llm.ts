// JSON chat against the OpenAI-compatible endpoint Midscene is configured with (same as mission/planner).
// chatCall is text-only; visionCall also sends images. Neither ever receives credentials.
// Every call returns its raw answer, a classified failure (never a bare `undefined`), the token usage, and is
// appended to the raw log when one is set (W3-2 §1.1). chatJson / visionJson keep their old signatures on top.
//
// Failure classification and retry policy ported from ref/artemis/artemis/llm/reliability.py L85-166
// (classify_failure, _DEFAULT_RETRY_POLICIES); the correction re-ask from ref/artemis/artemis/services/llm.py
// L805-860 (acomplete_structured) (Apache-2.0), rewritten in TypeScript. Attempt counts are smaller than
// Artemis' (a 180 s planning call is retried once on timeout, not twice).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseStructured } from './structured';

export interface Usage {
  input: number;
  output: number;
  /** Prompt tokens served from the provider's prefix cache, when it reports them. */
  cached: number;
}

/** Every model call, also by purpose (plan / prep / checkpoint / evidence / warmup / calibrate / sync / locate),
 *  and the tokens they used (summed over retries, corrections and continuations). */
export const modelCalls = {
  text: 0,
  vision: 0,
  byPurpose: {} as Record<string, number>,
  tokens: { input: 0, output: 0, cached: 0 } as Usage,
  tokensByPurpose: {} as Record<string, Usage>,
};

/** Listeners of every model call (trajectory). */
export const modelCallListeners = new Set<(e: { kind: 'text' | 'vision'; purpose: string }) => void>();
/** Listeners of every finished call with its result (raw log, context manifest). */
export const modelResultListeners = new Set<(r: CallRecord) => void>();

/** Count one call; `purpose` defaults to the current phase (setModelPurpose). */
export function countCall(kind: 'text' | 'vision', purpose = currentPurpose): void {
  modelCalls[kind]++;
  for (const l of modelCallListeners) l({ kind, purpose });
  const k = `${kind}:${purpose}`;
  modelCalls.byPurpose[k] = (modelCalls.byPurpose[k] ?? 0) + 1;
}
let currentPurpose = 'other';
export function setModelPurpose(p: string): void {
  currentPurpose = p;
}
export function modelPurpose(): string {
  return currentPurpose;
}

function addUsage(kind: 'text' | 'vision', purpose: string, u: Usage): void {
  for (const t of [modelCalls.tokens, (modelCalls.tokensByPurpose[`${kind}:${purpose}`] ??= { input: 0, output: 0, cached: 0 })]) {
    t.input += u.input;
    t.output += u.output;
    t.cached += u.cached;
  }
}

/** Pure: first JSON object in a model answer (code fences, thinking tags, comments, trailing commas tolerated). */
export function extractJson(text: string): unknown {
  const p = parseStructured(text, 'object');
  return p.ok ? p.value : undefined;
}

/** Pure: majority of boolean votes; null when no vote was cast or the vote is tied. */
export function majority(answers: (boolean | null)[]): { value: boolean | null; yes: number; no: number } {
  const yes = answers.filter((x) => x === true).length;
  const no = answers.filter((x) => x === false).length;
  return { value: !yes && !no ? null : yes === no ? null : yes > no, yes, no };
}

function cfg() {
  const base = process.env.MIDSCENE_PLANNING_MODEL_BASE_URL ?? process.env.MIDSCENE_MODEL_BASE_URL;
  const key = process.env.MIDSCENE_PLANNING_MODEL_API_KEY ?? process.env.MIDSCENE_MODEL_API_KEY;
  const model = process.env.ISSUE_PLANNER_MODEL ?? process.env.MISSION_PLANNER_MODEL ?? process.env.MIDSCENE_MODEL_NAME;
  return base && key && model ? { base, key, model } : undefined;
}

export function modelConfigured(): boolean {
  return !!cfg() && process.env.ISSUE_NO_MODEL !== '1';
}

function visionCfg() {
  const base = process.env.MIDSCENE_MODEL_BASE_URL;
  const key = process.env.MIDSCENE_MODEL_API_KEY;
  const model = process.env.EVIDENCE_VISION_MODEL ?? process.env.MIDSCENE_MODEL_NAME;
  return base && key && model ? { base, key, model } : undefined;
}

export function visionConfigured(): boolean {
  return !!visionCfg() && process.env.ISSUE_NO_VISION !== '1';
}

export type VisionPart = string | { label: string; png: Buffer; mime?: string };

// ---------------------------------------------------------------- failure classification and retries

export type FailCategory = 'rate-limit' | 'unavailable' | 'timeout' | 'connection' | 'auth' | 'bad-request' | 'unknown';

/** Retries after the first attempt and the pauses before them (ms), per category. */
export const RETRY_POLICY: Record<FailCategory, number[]> = {
  'rate-limit': [10_000, 30_000, 60_000],
  unavailable: [5_000, 20_000, 60_000],
  connection: [2_000, 8_000],
  timeout: [2_000],
  unknown: [1_000],
  auth: [],
  'bad-request': [],
};
/** Pauses before retrying a busy / failing vision service (kept for callers that print them). */
export const VISION_RETRY_MS = RETRY_POLICY.unavailable;

/** Pure: an HTTP status / transport error → its category (classify_failure). */
export function classifyFailure(err: { status?: number; name?: string; message?: string }): FailCategory {
  const s = err.status;
  const m = (err.message ?? '').toLowerCase();
  if (s === 429 || /rate limit|too many requests|quota/.test(m)) return 'rate-limit';
  if ((s !== undefined && [500, 502, 503, 504].includes(s)) || /service unavailable|overloaded|bad gateway/.test(m)) return 'unavailable';
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || /timed out|timeout|deadline exceeded/.test(m)) return 'timeout';
  if (s === 401 || s === 403) return 'auth';
  if (s !== undefined && [400, 404, 413, 415, 422].includes(s)) return 'bad-request';
  if (s === undefined && /fetch failed|econn|socket|network|enotfound|eai_again/.test(m)) return 'connection';
  return 'unknown';
}

let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Tests: replace the pause between retries. */
export function setRetrySleep(f: (ms: number) => Promise<void>): void {
  sleep = f;
}

// ---------------------------------------------------------------- raw log

let rawLogPath: string | undefined;
/** Append every call (raw answer, failure, usage, timing) to this JSONL file; undefined = stop. */
export function setModelRawLog(path: string | undefined): void {
  rawLogPath = path;
}

export interface CallRecord {
  t: string;
  kind: 'text' | 'vision';
  purpose: string;
  model?: string;
  ok: boolean;
  fail?: FailKind;
  error?: string;
  ms: number;
  /** HTTP requests made: retries, corrections and continuations included. */
  requests: number;
  finish?: string;
  usage: Usage;
  /** Prompt size in characters (text parts) and the number of images. */
  promptChars: number;
  images: number;
  raw: string;
}

function logRecord(r: CallRecord, extra?: string): void {
  for (const l of modelResultListeners) l(r);
  for (const p of new Set([rawLogPath, extra].filter((x): x is string => !!x))) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, `${JSON.stringify(r)}\n`);
    } catch {
      /* the log never breaks a call */
    }
  }
}

// ---------------------------------------------------------------- the call

/** Why a call gave no value. `http` / `timeout` / `connection`: the service; `truncated` / `parse`: the answer. */
export type FailKind = 'unconfigured' | 'http' | 'timeout' | 'connection' | 'truncated' | 'parse';

export type CallResult =
  | { ok: true; value: unknown; raw: string; usage: Usage; ms: number; requests: number }
  | { ok: false; fail: FailKind; category?: FailCategory; error: string; raw: string; usage: Usage; ms: number; requests: number };

export interface CallOptions {
  timeoutMs?: number;
  /** Counted under this purpose (default: the current phase). */
  purpose?: string;
  /** On a parse failure, show the model its error and ask once for the corrected JSON. Default false. */
  correct?: boolean;
  /** When the answer is cut off (finish_reason "length"), ask the model to continue, up to this many times. Default 2. */
  continuations?: number;
  /** Also append this call to this JSONL file. */
  rawLog?: string;
  /** Top-level JSON type expected. Default 'object'. */
  want?: 'object' | 'array' | 'any';
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: unknown };

export const CORRECTION_PROMPT = (error: string) =>
  `Your previous reply could not be parsed as the required JSON (${error}). Re-emit ONLY the corrected JSON object, with no prose or code fences.`;
export const CONTINUE_PROMPT = 'Your reply was cut off. Continue exactly where it stopped. Do not repeat anything and do not add any prose.';

type Endpoint = { base: string; key: string; model: string };
type Completion = { content: string; finish?: string; usage: Usage };

/** One request, retried per failure category. Throws the last error (with `category`) when it gives up. */
async function complete(c: Endpoint, messages: Msg[], timeoutMs: number, tag: string): Promise<Completion> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${c.base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
        body: JSON.stringify({ model: c.model, temperature: 0.1, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`), { status: res.status });
      const body = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };
      const u = body.usage ?? {};
      return {
        content: body.choices?.[0]?.message?.content ?? '',
        finish: body.choices?.[0]?.finish_reason,
        usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0 },
      };
    } catch (err) {
      const category = classifyFailure(err as Error & { status?: number });
      const pauses = RETRY_POLICY[category];
      const again = attempt < pauses.length;
      console.warn(`[${tag}] call failed (${category}: ${(err as Error).message.slice(0, 200)})${again ? ` — retrying in ${pauses[attempt] / 1000} s` : ''}`);
      if (!again) throw Object.assign(err as Error, { category });
      await sleep(pauses[attempt]);
    }
  }
}

const sum = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached });
const failKindOf = (category: FailCategory): FailKind => (category === 'timeout' ? 'timeout' : category === 'connection' ? 'connection' : 'http');

async function call(kind: 'text' | 'vision', c: Endpoint | undefined, system: string, content: unknown, promptChars: number, images: number, o: CallOptions): Promise<CallResult> {
  const t0 = Date.now();
  const purpose = o.purpose ?? currentPurpose;
  let usage: Usage = { input: 0, output: 0, cached: 0 };
  let requests = 0;
  let raw = '';
  let finish: string | undefined;
  const done = (r: CallResult): CallResult => {
    addUsage(kind, purpose, r.usage);
    logRecord({ t: new Date(t0).toISOString(), kind, purpose, model: c?.model, ok: r.ok, ...(r.ok ? {} : { fail: r.fail, error: r.error }), ms: r.ms, requests: r.requests, finish, usage: r.usage, promptChars, images, raw: r.raw }, o.rawLog);
    return r;
  };
  if (!c) return { ok: false, fail: 'unconfigured', error: 'model not configured', raw: '', usage, ms: 0, requests: 0 };
  countCall(kind, purpose);
  const tag = kind === 'vision' ? 'vision' : 'model';
  const messages: Msg[] = [{ role: 'system', content: system }, { role: 'user', content }];
  const request = async (msgs: Msg[]): Promise<Completion> => {
    requests++;
    const r = await complete(c, msgs, o.timeoutMs ?? 90_000, tag);
    usage = sum(usage, r.usage);
    finish = r.finish;
    return r;
  };
  try {
    let r = await request(messages);
    raw = r.content;
    // Cut off by the output limit: ask for the rest and stitch it on.
    for (let k = 0; r.finish === 'length' && k < (o.continuations ?? 2); k++) {
      r = await request([...messages, { role: 'assistant', content: raw }, { role: 'user', content: CONTINUE_PROMPT }]);
      raw += r.content;
    }
    let parsed = parseStructured(raw, o.want ?? 'object');
    if (!parsed.ok && o.correct) {
      const fix = await request([...messages, { role: 'assistant', content: raw }, { role: 'user', content: CORRECTION_PROMPT(parsed.error) }]);
      const again = parseStructured(fix.content, o.want ?? 'object');
      if (again.ok) {
        raw = fix.content;
        parsed = again;
      } else raw = `${raw}\n\n--- correction ---\n${fix.content}`;
    }
    if (parsed.ok) return done({ ok: true, value: parsed.value, raw, usage, ms: Date.now() - t0, requests });
    const truncated = finish === 'length';
    return done({ ok: false, fail: truncated ? 'truncated' : 'parse', error: truncated ? `answer cut off at ${raw.length} chars (${parsed.error})` : parsed.error, raw, usage, ms: Date.now() - t0, requests });
  } catch (err) {
    const category = (err as { category?: FailCategory }).category ?? 'unknown';
    return done({ ok: false, fail: failKindOf(category), category, error: `${category}: ${(err as Error).message.slice(0, 300)}`, raw, usage, ms: Date.now() - t0, requests });
  }
}

/** Text → JSON with the planning model. */
export async function chatCall(system: string, user: string, o: CallOptions = {}): Promise<CallResult> {
  const c = process.env.ISSUE_NO_MODEL === '1' ? undefined : cfg();
  return call('text', c, system, user, system.length + user.length, 0, o);
}

/** Pure: vision parts → OpenAI-compatible content parts. */
export function visionContent(parts: VisionPart[]): unknown[] {
  return parts.flatMap((p) =>
    typeof p === 'string' ? [{ type: 'text', text: p }] : [{ type: 'text', text: p.label }, { type: 'image_url', image_url: { url: `data:${p.mime ?? 'image/png'};base64,${p.png.toString('base64')}` } }],
  );
}

/** Images + text → JSON, against the vision model Midscene uses. A service that stays busy / failing after the
 *  retries sets `visionOutage` (cleared by the next answer), so callers tell a tool failure from a bad answer. */
export async function visionCall(system: string, parts: VisionPart[], o: CallOptions = {}): Promise<CallResult> {
  const c = process.env.ISSUE_NO_VISION === '1' ? undefined : visionCfg();
  const chars = system.length + parts.reduce((n, p) => n + (typeof p === 'string' ? p.length : p.label.length), 0);
  const r = await call('vision', c, system, visionContent(parts), chars, parts.filter((p) => typeof p !== 'string').length, { timeoutMs: 120_000, ...o });
  if (r.ok || r.fail === 'parse' || r.fail === 'truncated') visionOutage = undefined;
  else if (r.category && !['auth', 'bad-request'].includes(r.category)) visionOutage = r.error.slice(0, 200);
  return r;
}

/** Old interface: the parsed object, or undefined on any failure (the failure is in the raw log). */
export async function chatJson(system: string, user: string, timeoutMs = 90_000): Promise<unknown> {
  const r = await chatCall(system, user, { timeoutMs });
  return r.ok ? r.value : undefined;
}

/** Old interface: the parsed object, or undefined on any failure. */
export async function visionJson(system: string, parts: VisionPart[], timeoutMs = 120_000): Promise<unknown> {
  const r = await visionCall(system, parts, { timeoutMs });
  return r.ok ? r.value : undefined;
}

/** Set when the last vision call gave up on a busy / failing service (cleared by the next answer). */
export let visionOutage: string | undefined;
