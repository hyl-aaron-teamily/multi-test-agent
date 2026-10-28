// Where Issue files live (the one place): `issues/<id>.md`, or a path given as is.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type NormalizedIssue, parseIssue } from './parse';

export function issuePath(ref: string): string {
  return existsSync(ref) ? ref : resolve('issues', `${ref.replace(/\.md$/, '')}.md`);
}

/** The Issue a plan comes from; undefined for smoke / ad-hoc plans (no Issue file). */
export function loadIssueOf(ref: string): NormalizedIssue | undefined {
  const f = issuePath(ref);
  return existsSync(f) ? parseIssue(ref, readFileSync(f, 'utf8')) : undefined;
}
