import { describe, expect, it } from 'vitest';
import { type AskMeta, author, type AuthorContext, authorLogs } from './author';
import type { NormalizedIssue } from './parse';

const cx = (id: string): AuthorContext => ({
  issue: { id, images: [] } as unknown as NormalizedIssue,
  raw: `# Issue ${id}`,
  surface: 'android-app',
  env: 'prod',
  category: 'functional' as AuthorContext['category'],
  version: 1,
});

describe('issue/author call logs and failure reasons (W3-2)', () => {
  it('Issues designed in parallel each log to their own files and keep their own failure reason', async () => {
    const seen: Record<string, string[]> = {};
    const ask = async (_s: string, user: string, _i: unknown, meta?: AskMeta) => {
      const id = user.match(/# Issue (\d+)/)![1];
      await new Promise((r) => setTimeout(r, id === '11' ? 20 : 5)); // interleave the two designs
      (seen[id] ??= []).push(meta!.logs!.raw);
      meta!.failure = `failure of ${id}`;
      return undefined;
    };
    const [a, b] = await Promise.all([author(cx('11'), {}, ask), author(cx('22'), {}, ask)]);
    expect(seen['11']).toEqual([authorLogs('11').raw, authorLogs('11').raw]);
    expect(seen['22']).toEqual([authorLogs('22').raw, authorLogs('22').raw]);
    expect(a.errors).toEqual(['failure of 11']);
    expect(b.errors).toEqual(['failure of 22']);
  });

  it('a custom ask that leaves no reason still gets the generic message', async () => {
    const r = await author(cx('33'), {}, async () => undefined);
    expect(r.errors).toEqual(['模型没有返回可解析的 JSON']);
  });
});
