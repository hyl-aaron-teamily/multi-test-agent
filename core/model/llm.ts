// JSON chat against the OpenAI-compatible endpoint Midscene is configured with (same as mission/planner).
// chatJson is text-only; visionJson gets recorded evidence frames (incident review, never the hot loop).
// Neither ever receives credentials. Every call is counted (report: "model calls").

/** Every model call, also by purpose (plan / prep / checkpoint / evidence / warmup / calibrate / sync / locate). */
export const modelCalls = { text: 0, vision: 0, byPurpose: {} as Record<string, number> };

/** Count one call; `purpose` defaults to the current phase (setModelPurpose). */
export function countCall(kind: 'text' | 'vision', purpose = currentPurpose): void {
  modelCalls[kind]++;
  const k = `${kind}:${purpose}`;
  modelCalls.byPurpose[k] = (modelCalls.byPurpose[k] ?? 0) + 1;
}
let currentPurpose = 'other';
export function setModelPurpose(p: string): void {
  currentPurpose = p;
}

/** Pure: first {...} JSON object in a model answer (code fences tolerated). */
export function extractJson(text: string): unknown {
  const s = text.replace(/```(?:json)?/g, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return undefined;
  }
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

export async function chatJson(system: string, user: string, timeoutMs = 90_000): Promise<unknown> {
  const c = cfg();
  if (!c || process.env.ISSUE_NO_MODEL === '1') return undefined;
  countCall('text');
  try {
    const res = await fetch(`${c.base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ model: c.model, temperature: 0.1, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return extractJson(body.choices?.[0]?.message?.content ?? '');
  } catch (err) {
    console.warn(`[issue] model call failed (${(err as Error).message}); falling back to rules`);
    return undefined;
  }
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

export type VisionPart = string | { label: string; png: Buffer };

/** Images + text → JSON, against the vision model Midscene uses (OpenAI-compatible image_url parts).
 *  Used offline on recorded evidence only (never in the action loop). Counted as a vision call. */
export async function visionJson(system: string, parts: VisionPart[], timeoutMs = 120_000): Promise<unknown> {
  const c = visionCfg();
  if (!c || process.env.ISSUE_NO_VISION === '1') return undefined;
  countCall('vision');
  const content = parts.flatMap((p) =>
    typeof p === 'string' ? [{ type: 'text', text: p }] : [{ type: 'text', text: p.label }, { type: 'image_url', image_url: { url: `data:image/png;base64,${p.png.toString('base64')}` } }],
  );
  try {
    const res = await fetch(`${c.base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ model: c.model, temperature: 0.1, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return extractJson(body.choices?.[0]?.message?.content ?? '');
  } catch (err) {
    console.warn(`[vision] evidence call failed (${(err as Error).message})`);
    return undefined;
  }
}
