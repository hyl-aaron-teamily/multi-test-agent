// Where Issue files live (the one place): `issues/<id>.md`, Issues drafted from exploration findings in
// `issues/explore/<id>.md`, or a path given as is.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type NormalizedIssue, parseIssue } from './parse';

export const ISSUE_DIRS = () => [resolve('issues'), resolve('issues', 'explore')];

export function issuePath(ref: string): string {
  if (existsSync(ref)) return ref;
  const id = ref.replace(/\.md$/, '');
  return ISSUE_DIRS().map((d) => resolve(d, `${id}.md`)).find((f) => existsSync(f)) ?? resolve('issues', `${id}.md`);
}

export const issueExists = (id: string) => existsSync(issuePath(id));

/** Ids of every Issue (sample Issues first, then the ones drafted from exploration). */
export function issueIds(): string[] {
  return ISSUE_DIRS().flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : []));
}

/** The Issue a plan comes from; undefined for smoke / ad-hoc plans (no Issue file). */
export function loadIssueOf(ref: string): NormalizedIssue | undefined {
  const f = issuePath(ref);
  return existsSync(f) ? parseIssue(ref, readFileSync(f, 'utf8')) : undefined;
}
