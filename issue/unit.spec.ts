import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testPlanJsonSchema, verdictRuleFor } from '../platform/schema/test-plan';
import { classifyRules, surfacesFor } from './classify';
import { detectPlatforms, parseIssue } from './parse';
import { validatePlan } from './validate';

const load = (id: string) => parseIssue(id, readFileSync(`issues/${id}.md`, 'utf8'));

describe('issue parsing', () => {
  it('reads sections, frequency and steps', () => {
    const i = load('1594');
    expect(i.frequency).toBe('Intermittent');
    expect(i.platforms).toEqual(['web']);
    expect(i.steps.length).toBe(5);
    expect(i.featureArea).toMatch(/mention/i);
  });
  it('ignores platforms the reporter marks unverified', () => {
    expect(detectPlatforms('iOS app (primary); Android / RN and web unconfirmed — needs confirmation. Desktop macOS also worth checking.')).toEqual(['ios']);
    expect(detectPlatforms('Production — iOS app vs macOS desktop client + Web (exact iOS build not specified, please confirm)')).toEqual(['ios', 'web', 'desktop']);
  });
  it('empty document → empty flag', () => {
    expect(parseIssue('x', '').empty).toBe(true);
    expect(classifyRules(parseIssue('x', '')).category).toBe('not-executable');
  });
});

describe('classification of the sample issues', () => {
  const expected: Record<string, string> = {
    '1329': 'bug-intermittent',
    '1594': 'bug-intermittent',
    '1614': 'server-side',
    '1919': 'multi-account',
    '1922': 'not-executable', // platform/issue-overrides.yaml (user decision, see file)
    '2044': 'bug-always',
    '2122': 'feature',
    '2230': 'deferred',
    '2235': 'multi-account',
    '2336': 'feature',
  };
  for (const f of readdirSync('issues').filter((x) => x.endsWith('.md'))) {
    const id = f.replace('.md', '');
    it(`${id} → ${expected[id]}`, () => expect(classifyRules(load(id)).category).toBe(expected[id]));
  }
  it('iOS-only issues have no direct surface (substitution needed)', () => {
    expect(surfacesFor(load('1329').platforms)).toEqual([]);
    expect(surfacesFor(['web'])).toEqual(['desktop-web']);
  });
  it('2122 is a feature with a deferred multi-account part', () => expect(classifyRules(load('2122')).partialMultiAccount).toBe(true));
});

const basePlan = () => ({
  id: '1594-desktop-web-v1',
  issueRef: '1594',
  title: 't',
  category: 'bug-intermittent',
  surface: 'desktop-web',
  issueSurfaces: ['web'],
  env: 'prod',
  targets: [{ id: 'group', kind: 'group-conversation', guidance: 'g' }],
  setup: [{ type: 'node', node: { name: 'teamily.openConversation', input: { target: 'group' } } }],
  actions: [{ type: 'node', node: { name: 'teamily.typeMention', input: {} } }],
  checks: [{ kind: 'visual-region', page: 'mention-picker', region: 'picker', expect: 'picker shows' }],
  limits: { maxSteps: 1000, maxMinutes: 15, maxIntervalMs: 1000 },
  verdictRule: { anyHit: true },
  provenance: { generatedBy: 'rules', skillVersion: 'x' },
});

describe('plan validation', () => {
  it('accepts a well-formed plan', () => expect(validatePlan(basePlan()).errors).toEqual([]));
  it('rejects unknown element / node / target, slow intervals and wrong verdict rule', () => {
    const p: any = basePlan();
    p.actions.push({ type: 'tap', element: 'chat.nope' }, { type: 'node', node: { name: 'teamily.fly', input: {} } }, { type: 'wait', value: '1', delayAfterMs: 1000 });
    p.setup[0].node.input.target = 'ghost';
    p.verdictRule = { consecutiveHits: 3 };
    const v = validatePlan(p);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/unknown element chat.nope/);
    expect(v.errors.join('\n')).toMatch(/unknown node teamily.fly/);
    expect(v.errors.join('\n')).toMatch(/unknown target ghost/);
    expect(v.errors.join('\n')).toMatch(/verdictRule/);
  });
  it('schema refuses intervals above 1 s', () => {
    const p: any = basePlan();
    p.actions[0].delayAfterMs = 1500;
    expect(validatePlan(p).ok).toBe(false);
  });
  it('verdict rule follows the category; JSON schema exports', () => {
    expect(verdictRuleFor('bug-always')).toEqual({ consecutiveHits: 3 });
    expect(verdictRuleFor('bug-intermittent')).toEqual({ anyHit: true });
    expect(JSON.stringify(testPlanJsonSchema())).toMatch(/verdictRule/);
  });
});
