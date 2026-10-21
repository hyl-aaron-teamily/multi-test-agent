// Text-only JSON chat against the OpenAI-compatible endpoint Midscene is configured with (same as mission/planner).
// Never receives screenshots or credentials. Every call is counted (report: "model calls").
import { extractJson } from '../mission/planner';

export const modelCalls = { text: 0, vision: 0 };

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
  modelCalls.text++;
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
