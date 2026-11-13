// The exploration's expectation checklist (W3-4 §8.5 ①, D9): what each page should do, so the agent can find
// functional problems that show no error on screen (2063: long-press on a link message opens no menu). The file
// platform/explore/expectations.json is project knowledge (in git). First drafts come from the Issue drafts'
// `understanding.expected`; people add, edit and disable entries on the explore page. During a run only the
// current page's entries go into the prompt (at most PAGE_MAX), plus a short "not checked yet" list for coverage.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pageId } from '../pages';
import { exploreDir } from './known';
import { readJsonFile, writeJsonFile } from './store';

export type VerifyResult = '符合' | '不符合' | '无法验证';

export interface Expectation {
  id: string;
  /** Page id or name (engine/pages.ts); '' = not bound to a page (only in the "not checked yet" list). */
  page: string;
  trigger: string;
  expect: string;
  /** issue#<id> (extracted from a draft) or `manual`. */
  source: string;
  enabled: boolean;
  /** The trigger sends or changes something: offered to writable runs only (read-only runs cannot do it). */
  writes?: boolean;
  /** Why it is disabled, or a person's remark. */
  note?: string;
}

export interface ExpectationsFile {
  schemaVersion: 1;
  items: Expectation[];
}

export const expectationsPath = () => resolve(exploreDir(), 'expectations.json');
/** Entries of the current page in one prompt (§8.5 ①). */
export const PAGE_MAX = 8;
/** Entries of other pages in the "not checked yet" list. */
export const PENDING_MAX = 5;

export function readExpectations(file = expectationsPath()): Expectation[] {
  return readJsonFile<ExpectationsFile>(file)?.items ?? [];
}

export function writeExpectations(items: Expectation[], file = expectationsPath()): void {
  writeJsonFile(file, { schemaVersion: 1, items } satisfies ExpectationsFile);
}

/** Pure: a checklist entry is complete enough to use. */
export function checkExpectation(e: Partial<Expectation>): string | undefined {
  if (!e.id || !/^[\w.-]{1,64}$/.test(e.id)) return 'id 只能用字母、数字、点、横线、下划线（1–64 个字符）';
  if (!e.trigger?.trim()) return '缺少触发方式（trigger）';
  if (!e.expect?.trim()) return '缺少预期（expect）';
  if (e.page && !pageId(e.page)) return `不认识的页面「${e.page}」（engine/pages 的页面 id 或名字）`;
  return undefined;
}

// ---------------------------------------------------------------- first drafts from the Issue drafts

/** Surfaces the exploration runs on (D8: no browser runs this period). */
const EXPLORE_SURFACES = ['android-app'];

/** Pure: the page where the trigger happens, guessed from the understanding's words ('' = no guess). */
export function guessPage(text: string): string {
  if (/设置|Settings/i.test(text)) return 'settings';
  if (/会话列表|聊天列表|列表页|未读|chat list/i.test(text)) return 'home';
  if (/@|提及|mention/i.test(text)) return 'chat';
  if (/消息|会话|聊天|气泡|输入框|引用|回复|群聊|message|conversation|chat/i.test(text)) return 'chat';
  return '';
}

interface Understanding {
  subject?: string;
  trigger?: string;
  expected?: string;
}

/** Pure: every `understanding` object in a draft, with the surface of the sub-case it sits in. */
function understandings(x: unknown, surface = '', out: { u: Understanding; surface: string }[] = []): { u: Understanding; surface: string }[] {
  if (!x || typeof x !== 'object') return out;
  if (Array.isArray(x)) {
    for (const y of x) understandings(y, surface, out);
    return out;
  }
  const o = x as Record<string, unknown>;
  const s = typeof o.surface === 'string' ? o.surface : surface;
  if (o.understanding && typeof o.understanding === 'object') out.push({ u: o.understanding as Understanding, surface: s });
  for (const [k, v] of Object.entries(o)) if (k !== 'understanding') understandings(v, s, out);
  return out;
}

/** A trigger that sends or changes something (a read-only exploration cannot do it). */
export const WRITES = /发送|发出|发一条|发了|转发|撤回|删除|上传|拍照|设为|改成|修改/;
/** A trigger or an expectation that needs another client or account — one exploration on one phone cannot. */
const MULTI_CLIENT = { trigger: /另一位|另一个账号|其他成员|网页端|桌面|Web 端|iOS|Desktop|两端|多端/i, expect: /(iOS|Web|Desktop)\s*\/|各端|两端/i };

/** Pure: checklist entries from one draft — one per distinct expected result. */
export function fromDraft(draft: { issue?: { id?: string; platforms?: string[] } } & Record<string, unknown>): Expectation[] {
  const issue = String(draft.issue?.id ?? '');
  if (!issue || issue.startsWith('explore')) return [];
  const seen = new Map<string, { u: Understanding; surfaces: Set<string> }>();
  for (const { u, surface } of understandings(draft)) {
    if (!u.expected?.trim() || !u.trigger?.trim()) continue;
    const k = u.expected.trim();
    const e = seen.get(k) ?? { u, surfaces: new Set<string>() };
    if (surface) e.surfaces.add(surface);
    seen.set(k, e);
  }
  return [...seen.values()].map(({ u, surfaces }, i, all) => {
    const onPhone = !surfaces.size || [...surfaces].some((s) => EXPLORE_SURFACES.includes(s));
    const multi = MULTI_CLIENT.trigger.test(u.trigger!) || MULTI_CLIENT.expect.test(u.expected!);
    const page = guessPage(`${u.subject ?? ''} ${u.trigger ?? ''}`);
    const writes = WRITES.test(u.trigger!);
    return {
      id: `issue-${issue}${all.length > 1 ? `-${i + 1}` : ''}`,
      page,
      trigger: u.trigger!.trim(),
      expect: u.expected!.trim(),
      source: `issue#${issue}`,
      enabled: onPhone && !multi,
      ...(writes ? { writes: true } : {}),
      ...(!onPhone ? { note: `草稿只有 ${[...surfaces].join(' / ')} 的子用例；探索本期只在 android-app 上跑` } : multi ? { note: '要另一个端或另一个账号配合，单台手机上的探索做不了' } : !page ? { note: '没认出触发所在的页面：只在「尚未核对」里出现' } : {}),
    };
  });
}

/** Read every draft and turn its understandings into entries; entries already in the file (same id) are kept
 *  as people left them. Returns the merged list and what was added. */
export function extractFromDrafts(dir = resolve(process.env.AUTOTEST_DRAFTS_DIR ?? 'platform/plans/drafts'), existing = readExpectations()): { items: Expectation[]; added: Expectation[] } {
  const have = new Set(existing.map((e) => e.id));
  const added: Expectation[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let d: unknown;
    try {
      d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    for (const e of fromDraft(d as never)) if (!have.has(e.id)) (have.add(e.id), added.push(e));
  }
  return { items: [...existing, ...added], added };
}

// ---------------------------------------------------------------- in the run

export interface ExpectationCheck {
  step: number;
  result: VerifyResult;
  evidence: string;
}

/** One entry's outcome in a run (result page: each entry with its result and the steps). */
export interface ExpectationOutcome {
  id: string;
  page: string;
  trigger: string;
  expect: string;
  source: string;
  /** The latest decided result (符合 / 不符合 win over 无法验证); 未核对 = never checked. */
  result: VerifyResult | '未核对';
  checks: ExpectationCheck[];
  /** The finding a 不符合 became. */
  finding?: number;
}

/** Pure: entries the run carries — enabled ones; those that send or change something only in a writable run. */
export const activeExpectations = (items: Expectation[], writable = false) => items.filter((e) => e.enabled && (writable || !e.writes));

/** Pure: the decided result of an entry's checks. */
export function outcomeOf(checks: ExpectationCheck[]): ExpectationOutcome['result'] {
  const decided = checks.filter((c) => c.result !== '无法验证');
  return decided.at(-1)?.result ?? (checks.length ? '无法验证' : '未核对');
}

const line = (e: Expectation, o?: ExpectationOutcome) => `- [${e.id}] ${e.trigger} → ${e.expect}${o && o.result !== '未核对' ? `  (already checked: ${o.result})` : ''}`;

/** Pure: the prompt blocks for this page — its entries and those of the previous step's page (a trigger done
 *  there shows its result here: 2063 long-presses on 聊天页, the menu is 消息菜单), unchecked first, at most
 *  PAGE_MAX; and the "not checked yet" list of other pages (at most PENDING_MAX). Empty when nothing is left. */
export function expectationBlocks(items: Expectation[], page: { id: string; name: string }, outcomes: Map<string, ExpectationOutcome>, prev?: { id: string }): string[] {
  const on = (id: string) => items.filter((e) => e.page && pageId(e.page) === id);
  const here = on(page.id);
  const before = prev && prev.id !== page.id && prev.id !== 'unknown' ? on(prev.id) : [];
  const unchecked = (e: Expectation) => (outcomes.get(e.id)?.result ?? '未核对') === '未核对';
  // This page's unchecked entries first, then the previous page's, then the checked ones (marked as such).
  const pageList = [...here.filter(unchecked), ...before.filter(unchecked), ...here.filter((e) => !unchecked(e)), ...before.filter((e) => !unchecked(e))].slice(0, PAGE_MAX);
  const pending = items.filter((e) => unchecked(e) && !pageList.includes(e)).slice(0, PENDING_MAX);
  const out: string[] = [];
  if (pageList.length)
    out.push(
      `本页待核对的预期 (expectations for this page, ${page.name}). When you have done a trigger and can see the result, add to your answer "verify": {"id": "<id>", "result": "符合" | "不符合" | "无法验证", "evidence": "<what the screen shows, as visible facts>"} — 不符合 = the screen clearly contradicts the expectation; 无法验证 = you could not set it up here:\n${pageList.map((e) => line(e, outcomes.get(e.id))).join('\n')}`,
    );
  if (pending.length) out.push(`尚未核对 (expectations not checked yet in this run; go and try them when you can):\n${pending.map((e) => `- [${e.id}]${e.page ? ` (${e.page})` : ''} ${e.trigger} → ${e.expect}`).join('\n')}`);
  return out;
}

const RESULT_ALIASES: Record<string, VerifyResult> = { 符合: '符合', pass: '符合', passed: '符合', met: '符合', yes: '符合', ok: '符合', 不符合: '不符合', fail: '不符合', failed: '不符合', 'not met': '不符合', no: '不符合', violated: '不符合', 无法验证: '无法验证', unknown: '无法验证', unverifiable: '无法验证', 'cannot verify': '无法验证', skip: '无法验证' };

/** Pure: the answer's `verify` (one object or a list), or why it cannot be used (told back to the model; the
 *  action still runs). `ids` = the entries offered. */
export type VerifyItem = { id: string; result: VerifyResult; evidence: string };

export function readVerify(raw: unknown, ids: Set<string>): { checks: VerifyItem[]; error?: string } {
  if (raw === undefined || raw === null) return { checks: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const checks: VerifyItem[] = [];
  const errors: string[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') {
      errors.push('verify must be an object {id, result, evidence}');
      continue;
    }
    const o = x as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim().replace(/^\[|\]$/g, '') : '';
    const result = RESULT_ALIASES[String(o.result ?? '').trim().toLowerCase()] ?? RESULT_ALIASES[String(o.result ?? '').trim()];
    if (!ids.has(id)) {
      errors.push(`verify id '${id}' is not one of the listed expectations`);
      continue;
    }
    if (!result) {
      errors.push(`verify result must be 符合, 不符合 or 无法验证 (got '${String(o.result ?? '')}')`);
      continue;
    }
    const evidence = String(o.evidence ?? '').trim();
    if (result === '不符合' && !evidence) {
      errors.push(`verify ${id}: 不符合 needs evidence (what the screen shows)`);
      continue;
    }
    checks.push({ id, result, evidence });
  }
  return { checks, ...(errors.length ? { error: errors.join('; ') } : {}) };
}
