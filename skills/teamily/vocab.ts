// Teamily SKILL vocabulary: fixed element ids, reference regions and Node names.
// One source for calibration (what to find), the plan validator (what a plan may reference) and the
// planner prompt (what the LLM may use). Coordinates live in profiles/, never here.
import type { Surface } from '../../platform/accounts/types';
import { NODE_SPECS } from './node-specs';

export const SKILL_VERSION = '2026.10.21-1';

export interface ElementSpec {
  id: string;
  page: string;
  meaning: string;
  /** Expected visible change when tapped during self-check. */
  selfCheck: 'focus' | 'navigate' | 'popup' | 'none';
  surfaces: Surface[];
}

/** Surfaces showing the Teamily web UI. */
const WEB: Surface[] = ['desktop-web', 'mobile-web', 'android-web'];
const ALL: Surface[] = ['android-app', ...WEB];
/** Phone-layout surfaces (bottom bar, back button in the chat header). */
const MOBILE: Surface[] = ['android-app', 'mobile-web', 'android-web'];

export const ELEMENTS: ElementSpec[] = [
  { id: 'login.email', page: 'login', meaning: '邮箱输入框', selfCheck: 'focus', surfaces: WEB },
  { id: 'login.emailContinue', page: 'login', meaning: '“Continue with Email” 按钮', selfCheck: 'none', surfaces: WEB },
  { id: 'login.password', page: 'login-password', meaning: '密码输入框', selfCheck: 'focus', surfaces: WEB },
  { id: 'login.continue', page: 'login-password', meaning: '“Continue” 提交按钮', selfCheck: 'none', surfaces: WEB },
  { id: 'onboarding.skip', page: 'onboarding', meaning: '新浏览器首次登录后的新手引导页“跳过”按钮', selfCheck: 'navigate', surfaces: WEB },
  { id: 'popup.appBannerDismiss', page: 'home', meaning: '移动 Web 首次进入时“下载移动应用”弹窗的“忽略”按钮', selfCheck: 'popup', surfaces: ['mobile-web', 'android-web'] },
  { id: 'nav.chat', page: 'home', meaning: '左栏/底栏 聊天入口', selfCheck: 'navigate', surfaces: ALL },
  { id: 'nav.artifacts', page: 'home', meaning: '左栏 / 底栏 Artifacts 入口', selfCheck: 'navigate', surfaces: WEB },
  { id: 'nav.me', page: 'home', meaning: '左栏/底栏 “我” 入口（个人主页）', selfCheck: 'navigate', surfaces: ALL },
  { id: 'chatlist.search', page: 'home', meaning: '会话列表顶部搜索框', selfCheck: 'focus', surfaces: ALL },
  { id: 'chat.composer', page: 'chat', meaning: '消息输入框', selfCheck: 'focus', surfaces: ALL },
  { id: 'chat.send', page: 'chat', meaning: '发送按钮（输入内容后出现）', selfCheck: 'none', surfaces: ALL },
  { id: 'chat.back', page: 'chat', meaning: '聊天页返回会话列表（移动端）', selfCheck: 'navigate', surfaces: MOBILE },
  { id: 'profile.bell', page: 'profile', meaning: '个人主页头部右上角 🔔 通知入口', selfCheck: 'popup', surfaces: WEB },
  { id: 'artifacts.firstCard', page: 'artifacts', meaning: 'Artifacts 网格第一个卡片位（打开任意文档 / CloudDoc，新标签页）', selfCheck: 'navigate', surfaces: ['desktop-web'] },
  { id: 'clouddoc.bell', page: 'clouddoc', meaning: 'CloudDoc 文档头部右上角 🔔（帮助与头像之间；无通知时点击无可见变化，只作存在性检查）', selfCheck: 'none', surfaces: ['desktop-web'] },
  { id: 'artifacts.bell', page: 'artifacts', meaning: 'Artifacts 页主内容区右上角 🔔 通知入口', selfCheck: 'popup', surfaces: WEB },
];

/** Reference regions (stable parts of a page) used by visual-region checks. */
export const REGIONS: { page: string; region: string; meaning: string }[] = [
  { page: 'home', region: 'nav', meaning: '左侧导航栏（版本失效检测）' },
  { page: 'chat', region: 'composer', meaning: '输入框区域' },
  { page: 'mention-picker', region: 'picker', meaning: '输入 @ 后出现的成员/智能体选择器（存在 = 弹出）' },
];

export interface NodeSpec {
  name: string;
  input: Record<string, string>;
  doc: string;
  phase: 'any' | 'prepare-only';
}

/** Node vocabulary for planner and validator (single source: node-specs.ts). */
export const NODES: NodeSpec[] = NODE_SPECS.map((n) => ({ name: n.name, input: n.input, doc: n.doc, phase: n.phase }));

/** Dynamic targets: chosen by the model at preparation time following this guidance, then frozen. */
export const TARGET_GUIDANCE: Record<string, string> = {
  'group-conversation': '成员 ≥3 的群聊（会话列表头像为多人拼图，或名称含多个成员名/逗号）；@ 类问题用它',
  'other-conversation': '与目标群不同的任意会话（用于切换会话再切回）',
  'others-text-message': '别人发的普通文本消息（不是图片/卡片/系统消息），点赞类问题用它',
  'doc-artifact': 'Artifacts 列表中的任意文档卡片（DOC），用于打开 CloudDoc',
};

