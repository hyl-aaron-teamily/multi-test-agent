import { describe, expect, it } from 'vitest';
import { extractJson } from './llm';
import { jsonCandidates, parseStructured, repairJson, stripThinking } from './structured';

describe('core/model/structured (W3-2 F1)', () => {
  it('parses plain, fenced and prose-wrapped objects', () => {
    expect(parseStructured('{"a":1}')).toMatchObject({ ok: true, value: { a: 1 } });
    expect(parseStructured('Here you go:\n```json\n{"a": 2}\n```\nthanks')).toMatchObject({ ok: true, value: { a: 2 } });
    expect(parseStructured('I think {"a": 3} is it')).toMatchObject({ ok: true, value: { a: 3 } });
  });

  it('repairs trailing commas and comments outside strings', () => {
    expect(repairJson('{"a": [1, 2,], // note\n "b": "x // y", /* c */ "c": 3,}')).toBe('{"a": [1, 2], \n "b": "x // y",  "c": 3}');
    expect(parseStructured('{"a": [1, 2,],}')).toMatchObject({ ok: true, value: { a: [1, 2] } });
  });

  it('strips thinking tags before looking for JSON', () => {
    expect(stripThinking('<think>{"no": 1}</think> {"yes": 1}')).toBe('{"yes": 1}');
    expect(parseStructured('<thinking>maybe {"no":1}</thinking>\n{"yes": 2}')).toMatchObject({ ok: true, value: { yes: 2 } });
  });

  it('is string- and escape-aware: braces inside strings do not end the span', () => {
    expect(parseStructured('{"t": "a } b \\" { c", "n": 1}')).toMatchObject({ ok: true, value: { t: 'a } b " { c', n: 1 } });
  });

  it('a bracketed note before the object does not hide it', () => {
    expect(jsonCandidates('[note] then {"a": 1}')).toContain('{"a": 1}');
    expect(parseStructured('[note] then {"a": 1}', 'object')).toMatchObject({ ok: true, value: { a: 1 } });
    expect(extractJson('[x] {"a": 1}')).toEqual({ a: 1 });
  });

  it('a cut-off answer fails with the reason and keeps the raw text', () => {
    const raw = '{"a": [1, 2, {"b": "unterminated';
    const p = parseStructured(raw);
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.raw).toBe(raw);
      expect(p.error).toMatch(/no JSON|invalid JSON/);
    }
    expect(parseStructured('')).toMatchObject({ ok: false, error: 'empty response' });
    expect(parseStructured('no json here')).toMatchObject({ ok: false, error: 'no JSON object or array found in response' });
  });

  it('accepts everything the old first-{-to-last-} extractor accepted', () => {
    const old = (text: string) => {
      const s = text.replace(/```(?:json)?/g, '');
      const a = s.indexOf('{');
      const b = s.lastIndexOf('}');
      try {
        return a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : undefined;
      } catch {
        return undefined;
      }
    };
    for (const t of ['{"a":1}', 'x {"a":{"b":2}} y', '```json\n{"k":"v"}\n```', '{"a":"}"}', 'pre {"a":[1,{"b":2}]} post']) expect(extractJson(t)).toEqual(old(t));
  });
});
