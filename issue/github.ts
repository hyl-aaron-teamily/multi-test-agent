// GitHub Issue source (W3-1 P7, K9/K10): REST API only (no `gh` CLI — the `gh` on this machine's PATH is an
// unrelated Python package). Token: GITHUB_TOKEN in .env, else platform/secrets/github.token; never shown in a
// response, log or trajectory. Only repositories on the allow list are fetched (default Teamily-Inc/teamily-ai-all;
// GITHUB_REPOS=owner/repo,… to change); an Issue of another allowed repository gets the id <repo>-<n>.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodedError } from '../platform/lifecycle/status';

export const DEFAULT_REPO = 'Teamily-Inc/teamily-ai-all';
const TOKEN_FILE = () => resolve(process.env.GITHUB_TOKEN_FILE ?? 'platform/secrets/github.token');
const API = () => process.env.GITHUB_API_URL ?? 'https://api.github.com';
const TIMEOUT_MS = 15_000;

export const allowedRepos = (): string[] => (process.env.GITHUB_REPOS ?? DEFAULT_REPO).split(',').map((s) => s.trim()).filter(Boolean);

/** The token and where it came from (K9 order), or undefined. */
export function githubToken(): { token: string; source: '.env GITHUB_TOKEN' | 'platform/secrets/github.token' } | undefined {
  const e = process.env.GITHUB_TOKEN?.trim();
  if (e) return { token: e, source: '.env GITHUB_TOKEN' };
  const f = TOKEN_FILE();
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim();
    if (t) return { token: t, source: 'platform/secrets/github.token' };
  }
  return undefined;
}

export interface IssueRef {
  owner: string;
  repo: string;
  n: number;
}

/** Pure: https://github.com/<owner>/<repo>/issues/<n> → ref; anything else → BAD_INPUT (a PR link too). */
export function parseIssueUrl(url: string): IssueRef {
  const m = url.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)\/?(?:[?#].*)?$/);
  if (!m) throw new CodedError('BAD_INPUT', `只接受 https://github.com/<owner>/<repo>/issues/<n> 格式的链接：${url.slice(0, 120)}`);
  if (m[3] === 'pull') throw new CodedError('BAD_INPUT', `链接指向的是 PR，不是 Issue：${url}`);
  return { owner: m[1], repo: m[2], n: Number(m[4]) };
}

/** Pure: the local Issue id of a ref (the default repository keeps the bare number). */
export const issueIdOf = (r: IssueRef) => (`${r.owner}/${r.repo}`.toLowerCase() === DEFAULT_REPO.toLowerCase() ? String(r.n) : `${r.repo}-${r.n}`);

/** Pure: is the repository allowed? */
export const repoAllowed = (r: IssueRef, allow = allowedRepos()) => allow.some((a) => a.toLowerCase() === `${r.owner}/${r.repo}`.toLowerCase());

/** Pure: an HTTP failure → GITHUB_AUTH with the reason a person can act on (never the token). */
export function authError(status: number, what: string, body = ''): CodedError {
  if (status === 401) return new CodedError('GITHUB_AUTH', `GitHub 拒绝了 token（401）：token 无效或已过期 — ${what}`, '换一个有效的 fine-grained PAT（.env GITHUB_TOKEN 或 platform/secrets/github.token）');
  if (status === 403) return new CodedError('GITHUB_AUTH', `GitHub 拒绝访问（403）：没有仓库权限，或组织还没批准这个 token${/rate limit/i.test(body) ? '（也可能是速率限制）' : ''} — ${what}`, 'PAT 需要 Issues 只读（teamily-ai-all）和 Contents 只读（bug-screenshots），并经组织批准');
  if (status === 404) return new CodedError('GITHUB_AUTH', `GitHub 返回 404：Issue 不存在，或 token 看不到这个仓库 — ${what}`, '确认链接；私有仓库要求 token 有该仓库的读权限');
  return new CodedError('TOOL_FAILED', `GitHub 请求失败（HTTP ${status}）— ${what}`);
}

type Fetch = typeof fetch;

async function gh(path: string, accept: string, f: Fetch = fetch): Promise<Response> {
  const t = githubToken();
  if (!t) throw new CodedError('GITHUB_AUTH', '没有 GitHub token：在 .env 设置 GITHUB_TOKEN，或写入 platform/secrets/github.token', '用测试 / 机器人账号建 fine-grained PAT（只读：teamily-ai-all Issues、bug-screenshots Contents，90 天过期）');
  try {
    return await f(`${API()}${path}`, { headers: { authorization: `Bearer ${t.token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'multi-test-agent' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new CodedError('TOOL_FAILED', `连不上 GitHub（${(e as Error).name === 'TimeoutError' ? `${TIMEOUT_MS / 1000}s 超时` : (e as Error).message.split('\n')[0]}）`);
  }
}

export interface FetchedIssue {
  id: string;
  url: string;
  title: string;
  /** Markdown body as written. */
  body: string;
  /** Rendered body: carries signed URLs of user-attachments images. */
  bodyHtml: string;
  updatedAt: string;
  fetchedAt: string;
}

/** GET /repos/{o}/{r}/issues/{n} (full+json: body and body_html). */
export async function fetchIssue(url: string, f: Fetch = fetch): Promise<FetchedIssue> {
  const ref = parseIssueUrl(url);
  if (!repoAllowed(ref)) throw new CodedError('BAD_INPUT', `仓库 ${ref.owner}/${ref.repo} 不在白名单（${allowedRepos().join(', ')}）`, '需要时在 .env 设置 GITHUB_REPOS');
  const res = await gh(`/repos/${ref.owner}/${ref.repo}/issues/${ref.n}`, 'application/vnd.github.full+json', f);
  if (!res.ok) throw authError(res.status, `${ref.owner}/${ref.repo}#${ref.n}`, await res.text().catch(() => ''));
  const j = (await res.json()) as { title?: string; body?: string | null; body_html?: string; updated_at?: string; pull_request?: unknown; html_url?: string };
  if (j.pull_request) throw new CodedError('BAD_INPUT', `${url} 是 PR，不是 Issue`);
  return { id: issueIdOf(ref), url: j.html_url ?? url, title: j.title ?? '', body: j.body ?? '', bodyHtml: j.body_html ?? '', updatedAt: j.updated_at ?? '', fetchedAt: new Date().toISOString() };
}

/** Pure: the Markdown file written for a fetched Issue (K10: a source line first). */
export const issueMarkdown = (x: FetchedIssue) => `<!-- source: ${x.url} · updated_at ${x.updatedAt} · fetched_at ${x.fetchedAt} -->\n# ${x.title}\n\n${x.body.replace(/\r\n/g, '\n').trim()}\n`;

/** Raw bytes of a file in a repository (contents API, raw) — for github.com/…/blob/… screenshot links. */
export async function fetchBlob(owner: string, repo: string, ref: string, path: string, f: Fetch = fetch): Promise<Buffer> {
  const res = await gh(`/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, 'application/vnd.github.raw', f);
  if (!res.ok) throw authError(res.status, `${owner}/${repo}/${path}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface GithubStatus {
  configured: boolean;
  source?: string;
  login?: string;
  repos: { repo: string; ok: boolean; detail: string }[];
  rateRemaining?: number;
  error?: string;
  checkedAt: string;
}

let cache: { at: number; v: GithubStatus } | undefined;
export const STATUS_TTL_MS = 5 * 60_000;

/** Token state for the Web / doctor (cached 5 minutes): who it is, which allowed repositories it can read. */
export async function githubStatus(f: Fetch = fetch, fresh = false): Promise<GithubStatus> {
  if (!fresh && cache && Date.now() - cache.at < STATUS_TTL_MS) return cache.v;
  const t = githubToken();
  const checkedAt = new Date().toISOString();
  let v: GithubStatus;
  if (!t) v = { configured: false, repos: allowedRepos().map((repo) => ({ repo, ok: false, detail: '没有 token' })), checkedAt };
  else {
    try {
      const me = await gh('/user', 'application/vnd.github+json', f);
      const rate = Number(me.headers.get('x-ratelimit-remaining') ?? NaN);
      const login = me.ok ? ((await me.json()) as { login?: string }).login : undefined;
      const repos = [];
      for (const repo of allowedRepos()) {
        const r = await gh(`/repos/${repo}`, 'application/vnd.github+json', f);
        repos.push({ repo, ok: r.ok, detail: r.ok ? '可读' : authError(r.status, repo).message });
      }
      v = { configured: true, source: t.source, login, repos, rateRemaining: Number.isFinite(rate) ? rate : undefined, ...(me.ok ? {} : { error: authError(me.status, '/user').message }), checkedAt };
    } catch (e) {
      v = { configured: true, source: t.source, repos: [], error: (e as Error).message, checkedAt };
    }
  }
  cache = { at: Date.now(), v };
  return v;
}
