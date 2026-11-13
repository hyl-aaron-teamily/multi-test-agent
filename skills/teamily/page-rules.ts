// Teamily pages the executor can tell apart from the accessibility tree (W3-4 §8.2′, contract K3). Checked in
// order: overlays (message menu, @ picker, settings sheet) before the pages under them. A rule matches when at
// least `min` of its anchors are on screen (each anchor counted once) and, if `need` is set, at least one of
// those too. The zh anchors come from real dumps of the Android app (2026-10-21 / 11-09, Redmi test phone); the
// en ones follow the app's English strings and still need a dump of the English UI (V2).
import type { PageRule } from '../../engine/pages';

export const TEAMILY_PAGES: PageRule[] = [
  {
    id: 'message-menu',
    name: '消息菜单',
    anchors: {
      zh: ['回复', '问AI', '翻译', '复制', '转发', '多选', '添加到我的 Artifacts', '撤回', '删除', '举报'],
      en: ['Reply', 'Ask AI', 'Translate', 'Copy', 'Forward', 'Multiple Selection', 'Add to My Artifacts', 'Recall', 'Delete', 'Report'],
    },
    min: 4,
  },
  {
    id: 'mention-picker',
    name: '@ 选择器',
    anchors: { zh: ['所有人', '所有人类', '所有智能体', '关闭提及建议'], en: ['Everyone', 'All humans', 'All agents', 'All Humans', 'All Agents'] },
    min: 2,
  },
  {
    id: 'settings',
    name: '设置页',
    anchors: {
      zh: ['设置', '关闭设置', '套餐与账单', '使用情况', '积分中心', '创作赚钱', '邀请赚钱', '应用连接器', '退出登录'],
      en: ['Settings', 'Close settings', 'Plans & Billing', 'Usage', 'Credits Center', 'Create & Earn', 'Invite & Earn', 'App Connectors', 'Log out', 'Log Out'],
    },
    min: 3,
  },
  {
    id: 'chat',
    name: '聊天页',
    // The composer toolbar is there in every state of the page (scrolled, keyboard up, text typed).
    anchors: { zh: ['强化 prompt', '会议纪要', '口述', '邀请', '返回', 'Instant'], en: ['Enhance prompt', 'Meeting notes', 'Dictate', 'Invite', 'Back', 'Instant'] },
    need: { zh: ['强化 prompt', '会议纪要', '口述'], en: ['Enhance prompt', 'Meeting notes', 'Dictate'] },
    min: 3,
  },
  {
    id: 'home',
    name: '会话列表',
    anchors: {
      zh: ['新建群组', '搜索', /^置顶 · \d+$/, /^聊天 · \d+$/, '我的', '聊天', '智能体', '发现', '记忆', '成果'],
      en: ['New group', 'New Group', 'Search', /^Pinned · \d+$/, /^Chats · \d+$/, 'Me', 'Chats', 'Agents', 'Discover', 'Memory', 'Artifacts'],
    },
    need: { zh: ['新建群组', /^聊天 · \d+$/, /^置顶 · \d+$/], en: ['New group', 'New Group', /^Chats · \d+$/, /^Pinned · \d+$/] },
    min: 3,
  },
];
