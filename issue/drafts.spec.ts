import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonical, draftHash, loadSavedDraft, sha } from './drafts';
import type { Draft } from './planner';

const draft = (title: string): Draft => ({ issue: { id: 'x' } as any, classification: { category: 'bug-intermittent' } as any, status: 'plannable', reason: '', subcases: [{ sub: 'main', title, surface: 'desktop-web', plan: { id: 'p', title } as any, planErrors: [] }] });

describe('draft store (confirmation = execution)', () => {
  it('canonical JSON ignores key order', () => expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonical({ a: [{ c: 3, d: 2 }], b: 1 })));
  it('hash changes with plan content', () => expect(draftHash(draft('a'))).not.toBe(draftHash(draft('b'))));
  it('reuses a saved draft only for the same Issue text, env and intact content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drafts-'));
    const d = { ...draft('a'), env: 'prod', issueHash: sha('issue text') };
    d.hash = draftHash(d);
    writeFileSync(join(dir, 'x.json'), JSON.stringify(d));
    expect(loadSavedDraft('x', 'issue text', 'prod', dir)?.hash).toBe(d.hash);
    expect(loadSavedDraft('x', 'changed issue', 'prod', dir)).toBeUndefined();
    expect(loadSavedDraft('x', 'issue text', 'test', dir)).toBeUndefined();
    writeFileSync(join(dir, 'x.json'), JSON.stringify({ ...d, subcases: [{ ...d.subcases[0], plan: { id: 'p', title: 'edited' } }] }));
    expect(loadSavedDraft('x', 'issue text', 'prod', dir)).toBeUndefined();
  });
});
