// Structured-output parsing for model answers: strip thinking tags → take the JSON payload (fenced block first,
// then a balanced {...} / [...] span, string- and escape-aware) → JSON.parse → tolerant repair (comments,
// trailing commas) → parse again. A miss is a typed failure carrying the raw text and the reason, never `undefined`.
//
// Ported from ref/artemis/artemis/llm/structured.py L69-194 (extract_json_candidate, _balanced_span, repair_json,
// parse_structured) and ref/artemis/artemis/llm/parser.py L21-32 (extract_thinking_tags) (Apache-2.0), rewritten in
// TypeScript. Additions: every balanced span is tried in order (a bracketed note before the JSON does not hide it),
// and the old first-'{'-to-last-'}' slice is the last resort, so no answer the previous extractor accepted is lost.

export type Parsed<T = unknown> = { ok: true; value: T; raw: string } | { ok: false; raw: string; error: string };

const THINK_RE = /<(think|thinking|thought)>[\s\S]*?<\/\1>/gi;
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi;

/** Pure: the text without <think> / <thinking> / <thought> blocks. */
export function stripThinking(text: string): string {
  return text.replace(THINK_RE, '').trim();
}

/** Pure: the balanced {...} or [...] span starting at `start` (string / escape aware), or undefined. */
function balancedFrom(text: string, start: number): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((open === '{' && ch !== '}') || (open === '[' && ch !== ']') || open === undefined) return undefined;
      if (!stack.length) return text.slice(start, j + 1);
    }
  }
  return undefined;
}

/** Pure: every balanced span in the text, in order of their opening bracket. */
function balancedSpans(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    const span = balancedFrom(text, i);
    if (span) {
      out.push(span);
      i += span.length - 1;
    }
  }
  return out;
}

/** Pure: candidate JSON payloads, most likely first: fenced blocks, balanced spans, then the old outer slice. */
export function jsonCandidates(text: string): string[] {
  const t = text.trim();
  const out: string[] = [];
  for (const m of t.matchAll(FENCE_RE)) out.push(...balancedSpans(m[1].trim()));
  out.push(...balancedSpans(t));
  const s = t.replace(/```(?:json)?/g, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) out.push(s.slice(a, b + 1));
  return [...new Set(out)];
}

/** Pure: remove `//` and block comments and trailing commas outside of strings. */
export function repairJson(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === ',') {
      let k = i + 1;
      while (k < text.length && ' \t\r\n'.includes(text[k])) k++;
      if (k < text.length && (text[k] === ']' || text[k] === '}')) {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Pure: a model answer → parsed JSON, or the reason it could not be parsed. `want` restricts the top-level type. */
export function parseStructured<T = unknown>(raw: string, want: 'object' | 'array' | 'any' = 'any'): Parsed<T> {
  if (!raw || !raw.trim()) return { ok: false, raw: raw ?? '', error: 'empty response' };
  const candidates = jsonCandidates(stripThinking(raw));
  if (!candidates.length) return { ok: false, raw, error: 'no JSON object or array found in response' };
  let last = '';
  for (const c of candidates) {
    for (const variant of [c, repairJson(c)]) {
      try {
        const value = JSON.parse(variant) as unknown;
        const kind = Array.isArray(value) ? 'array' : value !== null && typeof value === 'object' ? 'object' : 'scalar';
        if (want !== 'any' && kind !== want) {
          last = `expected a JSON ${want}, found ${kind}`;
          continue;
        }
        return { ok: true, value: value as T, raw };
      } catch (e) {
        last = (e as Error).message;
      }
    }
  }
  return { ok: false, raw, error: `invalid JSON: ${last}` };
}
