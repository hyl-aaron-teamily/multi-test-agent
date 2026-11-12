import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpDir } from '../testing/tmp-dir';
import { chatCall, chatJson, classifyFailure, CONTINUE_PROMPT, modelCalls, setModelRawLog, setRetrySleep, visionCall, visionOutage } from './llm';

type Reply = { status?: number; content?: string; finish?: string; usage?: Record<string, number>; throws?: Error };
let replies: Reply[] = [];
let bodies: { messages: { role: string; content: unknown }[] }[] = [];
const ENV = { MIDSCENE_MODEL_BASE_URL: 'http://model.test/v1', MIDSCENE_MODEL_API_KEY: 'k', MIDSCENE_MODEL_NAME: 'm', ISSUE_NO_MODEL: '', ISSUE_NO_VISION: '', MIDSCENE_PLANNING_MODEL_BASE_URL: '', MIDSCENE_PLANNING_MODEL_API_KEY: '', ISSUE_PLANNER_MODEL: '', MISSION_PLANNER_MODEL: '', EVIDENCE_VISION_MODEL: '' };

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  for (const k of ['MIDSCENE_PLANNING_MODEL_BASE_URL', 'MIDSCENE_PLANNING_MODEL_API_KEY', 'ISSUE_PLANNER_MODEL', 'MISSION_PLANNER_MODEL', 'EVIDENCE_VISION_MODEL', 'ISSUE_NO_MODEL', 'ISSUE_NO_VISION']) delete process.env[k];
  replies = [];
  bodies = [];
  setRetrySleep(async () => {});
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const r = replies.shift() ?? { content: '{}' };
    if (r.throws) throw r.throws;
    if (r.status && r.status >= 400) return new Response('busy', { status: r.status });
    return new Response(JSON.stringify({ choices: [{ message: { content: r.content ?? '' }, finish_reason: r.finish ?? 'stop' }], usage: r.usage }), { status: 200 });
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setModelRawLog(undefined);
});

describe('core/model/llm (W3-2 F2)', () => {
  it('classifies failures like Artemis classify_failure', () => {
    expect(classifyFailure({ status: 429 })).toBe('rate-limit');
    expect(classifyFailure({ status: 503 })).toBe('unavailable');
    expect(classifyFailure({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' })).toBe('timeout');
    expect(classifyFailure({ message: 'fetch failed' })).toBe('connection');
    expect(classifyFailure({ status: 401 })).toBe('auth');
    expect(classifyFailure({ status: 400 })).toBe('bad-request');
  });

  it('retries a busy service, then answers; usage is summed', async () => {
    replies = [{ status: 503 }, { content: '{"a":1}', usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 } }];
    const before = { ...modelCalls.tokens };
    const r = await chatCall('sys', 'user');
    expect(r).toMatchObject({ ok: true, value: { a: 1 }, requests: 1, usage: { input: 100, output: 5, cached: 60 } });
    expect(bodies).toHaveLength(2);
    expect(modelCalls.tokens.input - before.input).toBe(100);
  });

  it('does not retry a bad request; the failure says why', async () => {
    replies = [{ status: 400 }];
    const r = await chatCall('sys', 'user');
    expect(r).toMatchObject({ ok: false, fail: 'http', category: 'bad-request' });
    expect(bodies).toHaveLength(1);
  });

  it('a timeout is retried once, then reported as a timeout (not as an unparseable answer)', async () => {
    const t = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    replies = [{ throws: t }, { throws: t }];
    const r = await chatCall('sys', 'user');
    expect(r).toMatchObject({ ok: false, fail: 'timeout' });
    expect(bodies).toHaveLength(2);
  });

  it('a cut-off answer is continued and stitched', async () => {
    replies = [{ content: '{"a": [1, 2,', finish: 'length' }, { content: ' 3]}' }];
    const r = await chatCall('sys', 'user');
    expect(r).toMatchObject({ ok: true, value: { a: [1, 2, 3] }, requests: 2 });
    expect(bodies[1].messages.at(-2)).toEqual({ role: 'assistant', content: '{"a": [1, 2,' });
    expect(bodies[1].messages.at(-1)).toEqual({ role: 'user', content: CONTINUE_PROMPT });
  });

  it('still cut off after the continuations → fail "truncated" with the raw text', async () => {
    replies = [{ content: '{"a": "x', finish: 'length' }, { content: 'y', finish: 'length' }, { content: 'z', finish: 'length' }];
    const r = await chatCall('sys', 'user');
    expect(r).toMatchObject({ ok: false, fail: 'truncated', raw: '{"a": "xyz' });
  });

  it('with `correct`, a parse failure is shown to the model once', async () => {
    replies = [{ content: 'sorry, here: {a: 1}' }, { content: '{"a": 1}' }];
    const r = await chatCall('sys', 'user', { correct: true });
    expect(r).toMatchObject({ ok: true, value: { a: 1 }, requests: 2 });
    expect(String(bodies[1].messages.at(-1)!.content)).toMatch(/could not be parsed as the required JSON/);
  });

  it('without `correct`, a parse failure is one request and fail "parse"', async () => {
    replies = [{ content: 'not json' }];
    expect(await chatCall('sys', 'user')).toMatchObject({ ok: false, fail: 'parse', raw: 'not json', requests: 1 });
    expect(await chatJson('sys', 'user')).toEqual({});
  });

  it('every call goes to the raw log, failures included', async () => {
    const f = join(tmpDir('llm-'), 'raw.jsonl');
    setModelRawLog(f);
    replies = [{ content: 'nope' }, { content: '{"ok":true}' }];
    await chatCall('sys', 'user', { purpose: 'unit' });
    await chatCall('sys', 'user', { purpose: 'unit' });
    const lines = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.ok, l.fail, l.raw])).toEqual([[false, 'parse', 'nope'], [true, undefined, '{"ok":true}']]);
    expect(lines[0]).toMatchObject({ kind: 'text', purpose: 'unit', promptChars: 7, images: 0 });
  });

  it('vision: a service that stays down sets visionOutage; the next answer clears it', async () => {
    replies = [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }];
    const r = await visionCall('sys', ['x', { label: 'img', png: Buffer.from('p') }]);
    expect(r).toMatchObject({ ok: false, fail: 'http', category: 'unavailable' });
    expect(visionOutage).toMatch(/unavailable/);
    replies = [{ content: '{"v":1}' }];
    expect(await visionCall('sys', ['x'])).toMatchObject({ ok: true });
    expect(visionOutage).toBeUndefined();
  });

  it('vision content keeps the old part layout (text, then label + image_url)', async () => {
    replies = [{ content: '{}' }];
    await visionCall('sys', ['prompt', { label: 'Screenshot', png: Buffer.from('p') }]);
    expect(bodies[0].messages[1].content).toEqual([
      { type: 'text', text: 'prompt' },
      { type: 'text', text: 'Screenshot' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('p').toString('base64')}` } },
    ]);
  });
});
