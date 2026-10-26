// Teamily SKILL Node table — the one source of Node names, input schemas, descriptions and phases.
// vocab.ts (planner prompt / validator) and nodes.ts (execution) both read it.
import { z } from 'zod';

export interface NodeSpecFull {
  name: string;
  schema: z.ZodObject<any>;
  /** Input field → meaning (planner prompt). */
  input: Record<string, string>;
  /** Chinese doc (SKILL / planner prompt). */
  doc: string;
  /** English one-liner (`autotest nodes`). */
  description: string;
  /** 'any': coordinates only (loop-safe). 'prepare-only': may locate (hierarchy / vision) — never in the loop. */
  phase: 'any' | 'prepare-only';
  /** Expected visible effect, verified in the warm-up round (observation id + args); none = not verified. */
  effect?: { observation: 'region'; page: string; region: string };
}

export const NODE_SPECS: NodeSpecFull[] = [
  { name: 'teamily.login', schema: z.object({ account: z.string().optional() }), input: { account: 'account id from the pool (resolved by the executor)' }, doc: '光标/键盘登录：邮箱 → 继续 → 密码 → 继续；Web 成功后缓存 storageState', description: 'Cursor/keyboard login: email → continue → password → continue (credentials from the account pool)', phase: 'any' },
  { name: 'teamily.openConversation', schema: z.object({ target: z.string() }), input: { target: 'target id decided in the preparation stage' }, doc: '点击准备阶段冻结的会话坐标，等待输入框出现', description: 'Tap a conversation frozen at preparation time', phase: 'any', effect: { observation: 'region', page: 'chat', region: 'composer' } },
  { name: 'teamily.sendMessage', schema: z.object({ text: z.string().min(1), kind: z.enum(['plain', 'markdown-link']).optional() }), input: { text: 'message text', kind: "'plain' (default) | 'markdown-link': text is sent as Markdown link syntax [text](text)" }, doc: '点输入框 → 键入 → 发送（kind=markdown-link 时以 Markdown 链接语法发送）', description: 'Tap composer, type, send', phase: 'any' },
  { name: 'teamily.typeMention', schema: z.object({}), input: {}, doc: '点输入框 → 键入 "@"（不发送），选择器应弹出', description: 'Tap composer, type "@" (picker should open)', phase: 'any' },
  { name: 'teamily.clearComposer', schema: z.object({}), input: {}, doc: '清空输入框（Esc 关闭弹层 + 退格）', description: 'Esc + backspace in the composer', phase: 'any' },
  { name: 'teamily.switchConversation', schema: z.object({ from: z.string(), to: z.string() }), input: { from: 'target id', to: 'target id' }, doc: '切到另一个会话再切回', description: 'Switch to another conversation and back', phase: 'any', effect: { observation: 'region', page: 'chat', region: 'composer' } },
  { name: 'teamily.openPage', schema: z.object({ page: z.enum(['profile', 'artifacts', 'chat']) }), input: { page: 'profile | artifacts | chat' }, doc: '通过导航入口打开固定页面', description: 'Open a fixed page through its navigation entry', phase: 'any' },
  { name: 'teamily.quoteReply', schema: z.object({ target: z.string(), text: z.string().min(1) }), input: { target: 'message target id (frozen)', text: 'reply text' }, doc: '长按目标消息 → 分层定位「引用/回复」菜单项 → 键入回复 → 发送（只在 prepare 用）', description: 'Long-press a message, choose quote/reply (located), type and send — prepare only', phase: 'prepare-only' },
];

export const nodeSpec = (name: string) => NODE_SPECS.find((n) => n.name === name);
