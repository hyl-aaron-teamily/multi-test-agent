import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockCatalog } from '../../issue/catalog';
import { SKILL_FILE, systemPrompt, systemSlots } from '../../issue/author';
import { tmpDir } from '../testing/tmp-dir';
import { assemble, modelCall, setContextManifestLog } from './assemble';
import { useCallLogs } from './logs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setContextManifestLog(undefined);
});

describe('core/context/assemble (W3-2 §1.3)', () => {
  it('joins system and user slots in order, with the given separators', () => {
    const a = assemble('t', [
      { name: 'a', role: 'system', content: 'A' },
      { name: 'u1', role: 'user', content: 'U1' },
      { name: 'b', role: 'system', content: 'B' },
      { name: 'u2', role: 'user', content: 'U2' },
    ], { userJoin: '\n' });
    expect(a.system).toBe('A\n\nB');
    expect(a.user).toBe('U1\nU2');
  });

  it('images become separate parts after the text that precedes them; empty slots are listed, not sent', () => {
    const png = Buffer.from('x');
    const a = assemble('t', [
      { name: 'text', role: 'user', content: 'prompt' },
      { name: 'shot', role: 'user', content: [{ label: 'S', png }] },
      { name: 'none', role: 'user', content: [] },
    ]);
    expect(a.user).toEqual(['prompt', { label: 'S', png }]);
    expect(a.manifest.slots.map((s) => [s.name, s.chars, s.images, !!s.empty])).toEqual([['text', 6, 0, false], ['shot', 1, 1, false], ['none', 0, 0, true]]);
    expect(a.manifest.images).toBe(1);
  });

  it('a slot over its budget is degraded and marked so', () => {
    const a = assemble('t', [{ name: 'h', role: 'user', content: 'x'.repeat(50), budget: 10, degrade: () => 'summary' }]);
    expect(a.user).toBe('summary');
    expect(a.manifest.slots[0]).toMatchObject({ degraded: true, chars: 7 });
  });

  it('the stable prefix hash changes only with the stable slots', () => {
    const h = (issue: string, rules = 'R') => assemble('t', [{ name: 'rules', role: 'system', stable: true, content: rules }, { name: 'issue', role: 'user', content: issue }]).manifest.prefixHash;
    expect(h('one')).toBe(h('two'));
    expect(h('one')).not.toBe(h('one', 'R2'));
  });

  it('W2-R2: the Issue-design system prompt is byte-identical to the W3-1 one (SKILL + "\\n\\n" + catalog)', () => {
    const old = `${readFileSync(SKILL_FILE, 'utf8')}\n\n${blockCatalog()}`;
    expect(systemPrompt()).toBe(old);
    expect(assemble('plan-author', systemSlots()).system).toBe(old);
  });

  it('modelCall sends the assembled prompt and logs the manifest with the outcome', async () => {
    vi.stubEnv('MIDSCENE_MODEL_BASE_URL', 'http://model.test/v1');
    vi.stubEnv('MIDSCENE_MODEL_API_KEY', 'k');
    vi.stubEnv('MIDSCENE_MODEL_NAME', 'm');
    for (const k of ['MIDSCENE_PLANNING_MODEL_BASE_URL', 'MIDSCENE_PLANNING_MODEL_API_KEY', 'ISSUE_PLANNER_MODEL', 'MISSION_PLANNER_MODEL', 'EVIDENCE_VISION_MODEL', 'ISSUE_NO_MODEL', 'ISSUE_NO_VISION']) delete process.env[k];
    const sent: { messages: { role: string; content: unknown }[] }[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }], usage: { prompt_tokens: 9, completion_tokens: 2 } }), { status: 200 });
    });
    const dir = tmpDir('ctx-');
    const end = useCallLogs(dir);
    const png = Buffer.from('p');
    const r = await modelCall({
      purpose: 'agent',
      vision: true,
      slots: [
        { name: 'role', role: 'system', stable: true, content: 'SYS' },
        { name: 'step', role: 'user', content: 'PROMPT' },
        { name: 'screenshot', role: 'user', content: [{ label: 'Screenshot', png }] },
      ],
    });
    end();
    expect(r).toMatchObject({ ok: true, value: { ok: 1 } });
    // Same request the W3-1 loop sent: visionJson(system, [prompt, { label, png }]).
    expect(sent[0].messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: [{ type: 'text', text: 'PROMPT' }, { type: 'text', text: 'Screenshot' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] },
    ]);
    const manifest = JSON.parse(readFileSync(join(dir, 'context-manifest.jsonl'), 'utf8').trim());
    expect(manifest).toMatchObject({ purpose: 'agent', ok: true, usage: { input: 9, output: 2, cached: 0 }, images: 1 });
    expect(manifest.slots.map((s: { name: string }) => s.name)).toEqual(['role', 'step', 'screenshot']);
    const raw = JSON.parse(readFileSync(join(dir, 'model-raw.jsonl'), 'utf8').trim());
    expect(raw).toMatchObject({ kind: 'vision', purpose: 'agent', ok: true, raw: '{"ok":1}' });
  });
});
