// Focus areas of an exploration (W3-4 §8.5 ⑤): the explore form offers the app's modules, ordered by how many
// existing Issues touch each (most first); the chosen ones are written into the goal so the agent goes there
// first.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface FocusModule {
  id: string;
  name: string;
  /** Words that put an Issue in this module (zh / en, case-insensitive). */
  words: RegExp;
}

export const MODULES: FocusModule[] = [
  { id: 'message-menu', name: '消息菜单（长按）', words: /长按|消息菜单|动作面板|long[- ]?press|action menu|context menu/i },
  { id: 'mention', name: '@ 提及', words: /提及|mention|[输键]入 ?@|@ ?(选择|浮窗|弹窗|列表)|@所有人|@me/i },
  { id: 'image', name: '图片 / 媒体', words: /图片|照片|相册|媒体|视频|image|photo|media|video/i },
  { id: 'quote', name: '引用 / 回复', words: /引用|回复|quote|reply/i },
  { id: 'link', name: '链接 / 卡片', words: /链接|卡片|预览|link|card|preview/i },
  { id: 'chat-list', name: '会话列表', words: /会话列表|聊天列表|未读|置顶|chat list|conversation list|unread|pinned/i },
  { id: 'composer', name: '输入框 / 草稿', words: /输入框|草稿|改写|composer|input box|draft|rewrite/i },
  { id: 'search', name: '搜索', words: /搜索|search/i },
  { id: 'notification', name: '通知', words: /通知|铃铛|notification|bell/i },
  { id: 'profile', name: '个人主页 / 关注', words: /个人主页|主页|关注|粉丝|profile|follow/i },
  { id: 'settings', name: '设置', words: /设置|settings/i },
  { id: 'agent', name: '智能体 / AI', words: /智能体|ask ai|问ai|personal ai|ai agent/i },
  { id: 'artifacts', name: '成果 / Artifacts', words: /成果|artifact|clouddoc/i },
  { id: 'group', name: '群组', words: /群组|建群|群成员|免打扰|group chat|group member|mute/i },
];

/** Pure: the modules an Issue text touches. */
export const modulesOf = (text: string) => MODULES.filter((m) => m.words.test(text)).map((m) => m.id);

/** Pure: the part of an Issue that says what it is about — title, the Summary's first paragraph, the "Feature
 *  area" line. The rest (steps, context, related Issues) mentions half the app and would put every Issue
 *  everywhere. */
export function aboutText(md: string): string {
  const title = md.match(/^#\s+(.+)$/m)?.[1] ?? '';
  const summary = md.match(/##\s*Summary\s*\n+([^\n]+)/i)?.[1] ?? md.slice(0, 400);
  const area = md.match(/Feature area\**:?\s*(.+)$/im)?.[1] ?? '';
  return `${title}\n${summary.slice(0, 600)}\n${area}`;
}

/** Pure: modules with their Issue counts, most first (ties keep the list's order). */
export function rankModules(issues: string[]): { id: string; name: string; issues: number }[] {
  const n = new Map<string, number>();
  for (const t of issues) for (const id of modulesOf(t)) n.set(id, (n.get(id) ?? 0) + 1);
  return MODULES.map((m, i) => ({ id: m.id, name: m.name, issues: n.get(m.id) ?? 0, i }))
    .sort((a, b) => b.issues - a.issues || a.i - b.i)
    .map(({ i: _, ...m }) => m);
}

/** The Issue texts on disk: local Issues, the samples in fixtures, and the drafts' issue summaries (one per id). */
export function issueTexts(root = resolve('.')): string[] {
  const byId = new Map<string, string>();
  for (const dir of [process.env.AUTOTEST_ISSUES_DIR ?? 'issues', 'fixtures/issues']) {
    const d = resolve(root, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => /^\d+\.md$/.test(f))) {
      const id = f.replace(/\.md$/, '');
      if (!byId.has(id)) byId.set(id, aboutText(readFileSync(join(d, f), 'utf8')));
    }
  }
  const drafts = resolve(root, process.env.AUTOTEST_DRAFTS_DIR ?? 'platform/plans/drafts');
  if (existsSync(drafts))
    for (const f of readdirSync(drafts).filter((f) => /^\d+\.json$/.test(f))) {
      const id = f.replace(/\.json$/, '');
      if (byId.has(id)) continue;
      try {
        const d = JSON.parse(readFileSync(join(drafts, f), 'utf8'));
        byId.set(id, `${d.issue?.title ?? ''}\n${String(d.issue?.summary ?? '').slice(0, 600)}`);
      } catch {
        /* unreadable draft */
      }
    }
  return [...byId.values()];
}

/** Pure: the goal with the chosen focus modules written in (§8.5 ⑤). Unknown ids are ignored. */
export function goalWithFocus(goal: string, focus: string[] | undefined): string {
  const names = (focus ?? []).map((id) => MODULES.find((m) => m.id === id)?.name).filter(Boolean);
  return names.length ? `${goal}\n重点区域（优先去这些地方）：${names.join('、')}` : goal;
}
