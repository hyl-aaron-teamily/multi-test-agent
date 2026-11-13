// W3-4 W4-R6: page recognition and recording (V2 on real dumps), the checklist per page, `verify` parsing, known
// issues (match, count, triage), D10, focus modules.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScreenNode } from '../../core/screen-index';
import { tmpDir } from '../../core/testing/tmp-dir';
import type { Finding } from '../agent/run';
import { emptyPages, langOf, mergePages, PageRecorder, pageOf, readPages, recordScreen, samePage, textKey } from '../pages';
import { activeExpectations, checkExpectation, type Expectation, expectationBlocks, type ExpectationOutcome, fromDraft, guessPage, outcomeOf, PAGE_MAX, readVerify } from './expectations';
import { findingKey, findingState, judgeFinding } from './judge';
import { D10_REASON, inputNotCommittedBefore, knownBlock, type KnownIssue, matchKnown, normText, readKnown, recordKnown, updateKnown } from './known';
import { goalWithFocus, modulesOf, rankModules } from './modules';

const FIX = 'fixtures/pages';
const fixture = (name: string): ScreenNode[] => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')).nodes;
const node = (text: string, extra: Partial<ScreenNode> = {}): ScreenNode => ({ text, desc: '', rid: '', cls: 'android.widget.TextView', clickable: false, box: [0, 0, 10, 10], center: { x: 5, y: 5 }, ...extra });

describe('pageOf (K3, V2 on real dumps of the Android app)', () => {
  it('every state of the chat page is the chat page; overlays win over the page under them', () => {
    const chats = readdirSync(FIX).filter((f) => f.startsWith('chat-')).map((f) => f.replace(/\.json$/, ''));
    expect(chats.length).toBeGreaterThanOrEqual(10);
    for (const c of chats) expect([c, pageOf(fixture(c)).id]).toEqual([c, 'chat']);
    expect(pageOf(fixture('home'))).toEqual({ id: 'home', name: '会话列表', lang: 'zh' });
    expect(pageOf(fixture('message-menu')).id).toBe('message-menu');
    expect(pageOf(fixture('mention-picker')).id).toBe('mention-picker');
    expect(pageOf(fixture('settings-logout-dialog')).id).toBe('settings');
  });
  it('an unrecognized screen is unknown; the English UI is told apart', () => {
    expect(pageOf([node('Hello'), node('World')]).id).toBe('unknown');
    expect(pageOf([]).id).toBe('unknown');
    const en = pageOf(['Reply', 'Ask AI', 'Translate', 'Copy', 'Forward'].map((t) => node(t)));
    expect(en).toEqual({ id: 'message-menu', name: '消息菜单', lang: 'en' });
    expect(langOf(fixture('home'))).toBe('zh');
    expect(langOf([node('Settings'), node('Log out')])).toBe('en');
  });
  it('a page reference may be the id or the name', () => {
    expect(samePage('聊天页', { id: 'chat', name: '聊天页' })).toBe(true);
    expect(samePage('chat', { id: 'chat', name: '聊天页' })).toBe(true);
    expect(samePage('@选择器', { id: 'mention-picker', name: '@ 选择器' })).toBe(true);
    expect(samePage('设置页', { id: 'chat', name: '聊天页' })).toBe(false);
  });
});

describe('page recording (§8.2′)', () => {
  it('texts and elements deduplicated per page (digits do not make a new text), counted once per screen; zh and en apart', () => {
    const f = emptyPages();
    recordScreen(f, fixture('chat-images'), 'android-app', '2026-11-13T00:00:00Z');
    recordScreen(f, fixture('chat-yesterday'), 'android-app', '2026-11-13T00:01:00Z');
    const chat = f.pages.zh.chat;
    expect(chat.seen).toBe(2);
    expect(chat.texts[textKey('强化 prompt')].n).toBe(2);
    // 「今天 16:43」 and 「今天 22:03」 are one text
    expect(textKey('今天 16:43')).toBe(textKey('今天 22:03'));
    expect(Object.keys(chat.texts).filter((k) => k.startsWith('今天')).length).toBe(1);
    expect(Object.keys(chat.elements).some((k) => k.startsWith('button "返回"'))).toBe(true);
    recordScreen(f, ['Reply', 'Ask AI', 'Translate', 'Copy', 'Forward'].map((t) => node(t)), 'android-app');
    expect(f.pages.en['message-menu'].seen).toBe(1);
    expect(f.pages.zh['message-menu']).toBeUndefined();
    recordScreen(f, [node('某个没认出的页面')], 'android-app');
    expect(Object.values(f.unknown.zh)[0].texts).toEqual(['某个没认出的页面']);
  });
  it('the recorder merges into the file (counts add up across processes)', () => {
    const file = join(tmpDir('w3m4-pages-'), 'pages.local.json');
    const a = new PageRecorder(file, 'android-app', 1000);
    a.observe(fixture('home'));
    a.flush();
    const b = new PageRecorder(file, 'android-app', 1000);
    b.observe(fixture('home'));
    b.observe(fixture('message-menu'));
    b.flush();
    const got = readPages(file);
    expect(got.pages.zh.home.seen).toBe(2);
    expect(got.pages.zh.home.texts[textKey('新建群组')].n).toBe(2);
    expect(got.pages.zh['message-menu'].seen).toBe(1);
    expect(mergePages(emptyPages(), got).pages.zh.home.seen).toBe(2);
  });
});

const E = (id: string, page: string, extra: Partial<Expectation> = {}): Expectation => ({ id, page, trigger: `${id} trigger`, expect: `${id} expect`, source: 'manual', enabled: true, ...extra });

describe('checklist (§8.5 ①, D9)', () => {
  it('first drafts from a draft: one per distinct expected result, the page guessed, desktop-only and multi-client ones off, writes flagged', () => {
    const draft = JSON.parse(readFileSync('platform/plans/drafts/2063.json', 'utf8'));
    const got = fromDraft(draft);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'issue-2063', page: 'chat', source: 'issue#2063', enabled: true });
    expect(got[0].expect).toContain('弹出与文字消息相同的消息动作面板');
    expect(got[0].writes).toBeUndefined();
    const desk = fromDraft({ issue: { id: '9' }, subcases: [{ surface: 'desktop-web', plan: { understanding: { trigger: '点开设置', expected: 'x' } } }] });
    expect(desk[0]).toMatchObject({ enabled: false, page: 'settings' });
    const multi = fromDraft({ issue: { id: '8' }, subcases: [{ surface: 'android-app', understanding: { trigger: '由群内另一位成员发一条 @ 到我的消息', expected: 'y' } }] });
    expect(multi[0].enabled).toBe(false);
    const send = fromDraft({ issue: { id: '7' }, subcases: [{ surface: 'android-app', understanding: { trigger: '在会话里发送一张图片', expected: 'z' } }] });
    expect(send[0]).toMatchObject({ enabled: true, writes: true });
    expect(activeExpectations(send)).toEqual([]);
    expect(activeExpectations(send, true)).toHaveLength(1);
    expect(guessPage('长按一条消息')).toBe('chat');
    expect(guessPage('打开个人主页')).toBe('');
  });
  it('only this page’s entries (and the previous step’s page) go into the prompt, unchecked first, at most 8; the rest in 尚未核对', () => {
    const items = [...Array.from({ length: 10 }, (_, i) => E(`c${i}`, 'chat')), E('menu', '消息菜单'), E('s', 'settings'), E('free', '')];
    const outcomes = new Map<string, ExpectationOutcome>(items.map((e) => [e.id, { ...e, result: '未核对', checks: [] }]));
    outcomes.get('c0')!.result = '符合';
    const [page, pending] = expectationBlocks(items, { id: 'chat', name: '聊天页' }, outcomes);
    expect(page).toMatch(/^本页待核对的预期 \(expectations for this page, 聊天页\)/);
    expect(page.match(/^- \[/gm)).toHaveLength(PAGE_MAX);
    expect(page).not.toContain('[c0]');
    expect(page).not.toContain('[menu]');
    expect(pending).toMatch(/^尚未核对/);
    expect(pending).toContain('[menu] (消息菜单)');
    // On the menu after a long-press on the chat page: the chat entries are still offered.
    const onMenu = expectationBlocks(items, { id: 'message-menu', name: '消息菜单' }, outcomes, { id: 'chat' })[0];
    expect(onMenu).toContain('[menu]');
    expect(onMenu).toContain('[c1]');
    // unknown page: only the pending list
    expect(expectationBlocks([E('a', 'chat')], { id: 'unknown', name: '未知页面' }, new Map())).toEqual(['尚未核对 (expectations not checked yet in this run; go and try them when you can):\n- [a] (chat) a trigger → a expect']);
    expect(checkExpectation(E('x', 'nowhere'))).toMatch(/不认识的页面/);
    expect(checkExpectation(E('x', '聊天页'))).toBeUndefined();
  });
  it('verify: one or many, results in words or aliases; unusable ones explained; 不符合 needs evidence', () => {
    const ids = new Set(['a', 'b']);
    expect(readVerify({ id: 'a', result: '不符合', evidence: '没有菜单' }, ids)).toEqual({ checks: [{ id: 'a', result: '不符合', evidence: '没有菜单' }] });
    expect(readVerify([{ id: '[a]', result: 'pass' }, { id: 'b', result: 'unknown' }], ids).checks.map((c) => c.result)).toEqual(['符合', '无法验证']);
    expect(readVerify({ id: 'z', result: '符合' }, ids).error).toMatch(/not one of the listed/);
    expect(readVerify({ id: 'a', result: 'maybe' }, ids).error).toMatch(/must be 符合, 不符合 or 无法验证/);
    expect(readVerify({ id: 'a', result: '不符合' }, ids).error).toMatch(/needs evidence/);
    expect(readVerify(undefined, ids)).toEqual({ checks: [] });
    expect(outcomeOf([])).toBe('未核对');
    expect(outcomeOf([{ step: 1, result: '不符合', evidence: '' }, { step: 2, result: '无法验证', evidence: '' }])).toBe('不符合');
  });
});

const finding = (n: number, extra: Partial<Finding>): Finding => ({ n, source: 'reported', kind: 'visual-anomaly', description: '', step: 1, screen: 's', incident: 'i', counted: true, path: [], page: 'home', ...extra });

describe('known issues across runs (§8.5 ④) and triage', () => {
  it('[自定义消息] twice in two runs: one known issue, count 2; times and counts do not make a new one', () => {
    const items: KnownIssue[] = [];
    const f1 = finding(1, { source: 'detector', detector: 'placeholder-text', text: '[自定义消息]', description: '界面上出现占位文字「[自定义消息]」' });
    judgeFinding(f1, [], items, 'run-1');
    expect(f1.known).toEqual({ id: 'K001', count: 1, isNew: true });
    const f2 = finding(3, { source: 'detector', detector: 'placeholder-text', text: '[自定义消息]', description: '界面上出现占位文字「[自定义消息]」' });
    judgeFinding(f2, [], items, 'run-2');
    expect(f2.known).toEqual({ id: 'K001', count: 2, isNew: false });
    expect(items).toHaveLength(1);
    // the same finding of the same run is not counted twice
    judgeFinding({ ...f2 }, [], items, 'run-2');
    expect(items[0].count).toBe(2);
    expect(normText('一直在加载（「加载中」）已持续 16 秒')).toBe(normText('一直在加载（「加载中」）已持续 23 秒'));
    expect(findingState(f2)).toBe('已知问题 K001（累计 2 次）');
  });
  it('model reports worded a little differently match; another page or type does not', () => {
    const items: KnownIssue[] = [];
    recordKnown(items, { page: 'home', type: 'reported', text: '「未读」筛选下同时出现会话和「没有未读会话」', description: 'a' }, { run: 'r1', n: 1, at: 't' });
    expect(matchKnown(items, { page: 'home', type: 'reported', text: '「未读」筛选下同时出现会话和「没有未读会话」提示' })?.id).toBe('K001');
    expect(matchKnown(items, { page: 'chat', type: 'reported', text: '「未读」筛选下同时出现会话和「没有未读会话」' })).toBeUndefined();
    expect(matchKnown(items, { page: 'home', type: 'reported', text: '头像显示成灰色方块' })).toBeUndefined();
  });
  it('a known issue people marked 不是问题 / 环境问题 does not count again; uncounted findings are only linked', () => {
    const items: KnownIssue[] = [];
    recordKnown(items, { page: 'home', type: 'reported', text: '骨架屏一直不消失', description: '骨架屏一直不消失' }, { run: 'r1', n: 1, at: 't' });
    items[0].triage = { verdict: 'env', at: 't' };
    const f = finding(2, { description: '骨架屏一直不消失' });
    judgeFinding(f, [], items, 'r2');
    expect(f.counted).toBe(false);
    expect(f.excluded).toMatch(/已被人工标注为「环境问题」/);
    expect(items[0].count).toBe(1);
    const g = finding(3, { description: '另一个没过复核的问题', counted: false });
    judgeFinding(g, [], items, 'r2');
    expect(g.known).toBeUndefined();
    expect(items).toHaveLength(1);
  });
  it('the prompt block lists this page’s known issues, most frequent first', () => {
    const items: KnownIssue[] = [];
    recordKnown(items, { page: 'home', type: 'reported', text: 'a', description: '会话列表里出现 [自定义消息]' }, { run: 'r1', n: 1, at: 't' });
    recordKnown(items, { page: 'chat', type: 'reported', text: 'b', description: '卡片图文不符' }, { run: 'r1', n: 2, at: 't' });
    expect(knownBlock(items, 'home')).toMatch(/^已记录的问题 \(known issues on this page: already recorded — do not report them again and do not spend steps on them here\):\n- 会话列表里出现 \[自定义消息\] \(seen 1×\)$/);
    expect(knownBlock(items, 'settings')).toBe('');
  });
  it('the file is read and written around each change', () => {
    const file = join(tmpDir('w3m4-known-'), 'known.json');
    updateKnown((items) => recordKnown(items, { page: 'home', type: 'x', text: 't', description: 'd' }, { run: 'r', n: 1, at: 't' }), file);
    updateKnown((items) => recordKnown(items, { page: 'home', type: 'x', text: 't', description: 'd' }, { run: 'r2', n: 1, at: 't' }), file);
    expect(readKnown(file)[0].count).toBe(2);
  });
  it('the key of each kind of finding', () => {
    expect(findingKey(finding(1, { source: 'expectation', expectation: { id: 'issue-2063', trigger: 't', expect: 'e' }, description: '不符合预期…' }))).toEqual({ page: 'home', type: 'expectation:issue-2063', text: 'issue-2063' });
    expect(findingKey(finding(1, { source: 'hard', kind: 'crash', description: 'crash: pid 123' })).type).toBe('hard:crash');
  });
});

describe('D10: no "typed text does not show" report after input not committed', () => {
  const steps = [{ step: 3, readback: ['input not committed'] }, { step: 4 }];
  it('after input not committed: not counted (test method); after a read-back with the text: reported as usual', () => {
    expect(inputNotCommittedBefore(steps, 5, '搜索框里不显示输入的文字')).toBe(true);
    expect(inputNotCommittedBefore(steps, 5, 'search box stays empty: the typed text is not shown')).toBe(true);
    expect(inputNotCommittedBefore(steps, 5, '键盘候选栏乱码 a\'a\'ro\'a\'a\'ron')).toBe(true);
    expect(inputNotCommittedBefore([{ step: 3, readback: ['aaron'] }], 5, '搜索框里不显示输入的文字')).toBe(false);
    expect(inputNotCommittedBefore([...steps, { step: 6, readback: ['aaron'] }], 7, '搜索框里不显示输入的文字')).toBe(false);
    expect(inputNotCommittedBefore([{ step: 3, readback: ['input not committed'] }, { step: 4, readback: ['field not readable'] }], 5, '输入框为空')).toBe(true);
    expect(inputNotCommittedBefore(steps, 5, '头像显示成灰色方块')).toBe(false);
    expect(inputNotCommittedBefore([], 5, '搜索框里不显示输入的文字')).toBe(false);
    const f = finding(1, { description: '搜索框里不显示输入的文字', step: 5 });
    const items: KnownIssue[] = [];
    judgeFinding(f, steps, items, 'r');
    expect(f).toMatchObject({ counted: false, excluded: D10_REASON });
    expect(items).toEqual([]);
    // a detector's or a person's finding is not touched by D10
    const h = finding(2, { source: 'human', description: '搜索框里不显示输入的文字', step: 5 });
    judgeFinding(h, steps, items, 'r');
    expect(h.counted).toBe(true);
  });
});

describe('focus modules (§8.5 ⑤)', () => {
  it('ranked by Issue counts; the chosen ones written into the goal', () => {
    expect(modulesOf('long-press a link message: the action menu never opens')).toEqual(expect.arrayContaining(['message-menu', 'link']));
    const r = rankModules(['长按消息没有菜单', '长按图片没有菜单', '设置里少了开关']);
    expect(r[0]).toMatchObject({ id: 'message-menu', issues: 2 });
    expect(r.find((m) => m.id === 'settings')?.issues).toBe(1);
    expect(goalWithFocus('探索消息模块', ['message-menu', 'nope', 'mention'])).toBe('探索消息模块\n重点区域（优先去这些地方）：消息菜单（长按）、@ 提及');
    expect(goalWithFocus('g', [])).toBe('g');
  });
});
