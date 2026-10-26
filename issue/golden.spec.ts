// Golden: the pattern library builds exactly what issue/planner.ts#templateFor built before the move
// (issue/__golden__/templates.json, captured on 2026-10-26 from the pre-W2-1 code).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyRules } from './classify';
import { parseIssue } from './parse';
import { splitSubcases, templateFor } from './planner';

const golden = JSON.parse(readFileSync('issue/__golden__/templates.json', 'utf8')) as Record<string, unknown>;

describe('pattern library = pre-W2-1 templates', () => {
  const issues = readdirSync('issues').filter((f) => f.endsWith('.md'));
  for (const f of issues) {
    const id = f.replace('.md', '');
    const i = parseIssue(id, readFileSync(`issues/${f}`, 'utf8'));
    const c = classifyRules(i);
    if (!['bug-always', 'bug-intermittent', 'feature', 'suspected-misuse'].includes(c.category)) continue;
    const subs = c.category === 'feature' ? [{ sub: 'main', text: `${i.summary} ${i.expected}` }] : splitSubcases(i);
    for (const sc of subs)
      for (const s of ['android-app', 'android-web', 'mobile-web', 'desktop-web'] as const)
        it(`${id}/${sc.sub}/${s}`, () => {
          expect(JSON.parse(JSON.stringify(templateFor(`${sc.text} ${c.category === 'feature' ? i.featureArea : ''}`, c.category as any, s)))).toEqual(golden[`${id}/${sc.sub}/${s}`]);
        });
  }
  it('covers every golden entry', () => expect(Object.keys(golden).length).toBe(28));
});
