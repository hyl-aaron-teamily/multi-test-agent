// Teamily SKILL precondition library (W2-1 §5.2): what a contract's preconditions may reference and how
// each is established on a surface:
//   executor        — the executor does it (signed in, app launched)
//   target:<kind>   — existing data, picked at preparation (TARGET_GUIDANCE)
//   construct       — built by the plan's prepare steps, only in allow-listed conversations (D5)
//   unconstructible — a black-box robot cannot build it (→ deferred)
import type { Surface } from '../../platform/schema/test-plan';

export type Establish = 'executor' | 'existing-data' | 'construct' | 'unconstructible';

export interface PreconditionSpec {
  id: string;
  meaning: string;
  establish: Establish;
  /** existing-data: the target kind that provides it. */
  target?: string;
  surfaces?: Surface[];
}

export const PRECONDITIONS: PreconditionSpec[] = [
  { id: 'logged-in', meaning: '已登录（账号池账号）', establish: 'executor' },
  { id: 'group-conversation', meaning: '存在成员 ≥3 的群聊', establish: 'existing-data', target: 'group-conversation' },
  { id: 'other-conversation', meaning: '存在另一个会话（切换用）', establish: 'existing-data', target: 'other-conversation' },
  { id: 'others-text-message', meaning: '会话里有别人发的普通文本消息', establish: 'existing-data', target: 'others-text-message' },
  { id: 'muted-group-with-mention', meaning: '有一个免打扰且被 @ 的群', establish: 'existing-data', target: 'muted-group' },
  { id: 'quote-reply-exists', meaning: '会话里已有一条引用回复', establish: 'existing-data', target: 'quote-card' },
  { id: 'quoted-message-with-markdown-link', meaning: '一条含 Markdown 链接语法的消息被引用回复', establish: 'construct', surfaces: ['android-app', 'android-web', 'mobile-web', 'desktop-web'] },
  { id: 'app-in-background', meaning: 'App 处于后台 / 被杀后重开', establish: 'executor', surfaces: ['android-app', 'android-web'] },
  { id: 'browser-storage-full', meaning: '浏览器存储（localStorage）写满', establish: 'unconstructible' },
  { id: 'second-account', meaning: '需要第二个账号 / 第二个客户端配合', establish: 'unconstructible' },
];

export const preconditionById = (id: string) => PRECONDITIONS.find((p) => p.id === id);
