import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validatePlan } from './validate';
import { coverageOf, rulesContract } from './contract';
import { parseIssue } from './parse';
import { draftIssue } from './planner';

const issue = (id: string) => parseIssue(id, readFileSync(`issues/${id}.md`, 'utf8'));

describe('intent contract (rules)', () => {
  it('2044: constructed precondition, quote-preview pattern, text observation, phenomenon from Actual', () => {
    const i = issue('2044');
    const c = rulesContract(i, 'main', i.summary, 'bug-always');
    expect(c.trigger.pattern).toBe('quote-preview-text');
    expect(c.preconditions.map((p) => p.establish)).toContain('construct');
    expect(c.observable.observation).toBe('text');
    expect(c.observable.phenomenon).toMatch(/Markdown|\[https/);
  });
  it('generic fallback does not cover a non-crash phenomenon', () => {
    const c = { observable: { observation: 'text' } } as any;
    expect(coverageOf({ checks: [{ kind: 'crash', expect: '', want: 'absent' }] }, c)).toBe('not-covered');
    expect(coverageOf({ checks: [{ kind: 'text', expect: '', want: 'absent', match: { contains: 'x' } }] }, c)).toBe('covered');
  });
  it('drafts (no model): every plan carries a contract and a coverage; specific patterns compile deterministically', async () => {
    for (const id of ['1594', '1329', '2336', '2122', '2044']) {
      const d = await draftIssue(issue(id), { useModel: false });
      for (const s of d.subcases) {
        expect(s.contract?.issueRef).toBe(id);
        expect(s.plan.coverage).toBeDefined();
        expect(validatePlan(s.plan).ok).toBe(true);
      }
    }
    const d2044 = await draftIssue(issue('2044'), { useModel: false });
    expect(d2044.subcases[0].plan.provenance.pattern).toBe('quote-preview-text');
    expect(d2044.subcases[0].plan.coverage).toBe('covered');
  });
  it('validator keeps prepare-only nodes out of the loop and keyboard checks off emulated phones', () => {
    const base = { id: 'x', issueRef: 'x', title: 't', category: 'bug-intermittent', surface: 'mobile-web', issueSurfaces: [], env: 'prod', targets: [], setup: [], prepare: [], afterCheck: [], limits: { maxSteps: 10, maxMinutes: 5, maxIntervalMs: 1000 }, verdictRule: { anyHit: true }, provenance: { generatedBy: 'rules', skillVersion: 's' } };
    const v = validatePlan({ ...base, actions: [{ type: 'node', node: { name: 'teamily.quoteReply', input: { quote: 'a', text: 'b' } } }], checks: [{ kind: 'keyboard', expect: 'k' }] });
    expect(v.errors.join('\n')).toMatch(/prepare-only/);
    expect(v.errors.join('\n')).toMatch(/keyboard-shown has no channel on mobile-web/);
  });
});
