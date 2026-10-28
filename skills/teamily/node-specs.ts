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
  /** Plain-Chinese step for people (W2-3 §6.1): {field} = the Node input, {target:field} = the target's
   *  description. Plan views and the report lead render steps from it — never hand-written. */
  zh: string;
  /** The visible result depends on the service, not only on the app (uncertainty in the plan view). */
  serverDependent?: string;
}

export const NODE_SPECS: NodeSpecFull[] = [
  { name: 'teamily.login', schema: z.object({ account: z.string().optional() }), input: { account: 'account id from the pool (resolved by the executor)' }, doc: '光标/键盘登录：邮箱 → 继续 → 密码 → 继续；Web 成功后缓存 storageState', description: 'Cursor/keyboard login: email → continue → password → continue (credentials from the account pool)', phase: 'any', zh: '用账号池里的账号登录（邮箱 → 继续 → 密码 → 继续）' },
  { name: 'teamily.openConversation', schema: z.object({ target: z.string() }), input: { target: 'target id decided in the preparation stage' }, doc: '点击准备阶段冻结的会话坐标，等待输入框出现', description: 'Tap a conversation frozen at preparation time', phase: 'any', effect: { observation: 'region', page: 'chat', region: 'composer' }, zh: '打开会话「{target:target}」（点准备阶段记下的位置），等输入框出现' },
  { name: 'teamily.sendMessage', schema: z.object({ text: z.string().min(1), kind: z.enum(['plain', 'markdown-link']).optional() }), input: { text: 'message text', kind: "'plain' (default) | 'markdown-link': text is sent as Markdown link syntax [text](text)" }, doc: '点输入框 → 键入 → 发送（kind=markdown-link 时以 Markdown 链接语法发送）', description: 'Tap composer, type, send', phase: 'any', zh: '点输入框，键入「{text}」并发送（会真的发出一条消息）' },
  { name: 'teamily.typeMention', schema: z.object({}), input: {}, doc: '点输入框 → 键入 "@"（不发送），选择器应弹出', description: 'Tap composer, type "@" (picker should open)', phase: 'any', zh: '点输入框，键入「@」（不发送），成员选择器应弹出' },
  { name: 'teamily.clearComposer', schema: z.object({}), input: {}, doc: '清空输入框（全选 + 删除；App 上保持输入框聚焦、键盘弹出；Web 先 Esc 关闭弹层）', description: 'Select all + delete in the composer (App: stays focused)', phase: 'any', zh: '清空输入框（全选 + 删除）' },
  { name: 'teamily.switchConversation', schema: z.object({ from: z.string(), to: z.string() }), input: { from: 'target id', to: 'target id' }, doc: '切到另一个会话再切回', description: 'Switch to another conversation and back', phase: 'any', effect: { observation: 'region', page: 'chat', region: 'composer' }, zh: '切到会话「{target:to}」再切回「{target:from}」' },
  { name: 'teamily.openPage', schema: z.object({ page: z.enum(['profile', 'artifacts', 'chat']) }), input: { page: 'profile | artifacts | chat' }, doc: '通过导航入口打开固定页面', description: 'Open a fixed page through its navigation entry', phase: 'any', zh: '通过导航入口打开「{page}」页' },
  { name: 'teamily.quoteReply', schema: z.object({ quote: z.string().min(1), text: z.string().min(1) }), input: { quote: 'literal text of the message to quote (located on screen)', text: 'reply text' }, doc: '长按目标消息 → 分层定位「引用/回复」菜单项 → 键入回复 → 发送（只在 prepare 用）', description: 'Long-press a message, choose quote/reply (located), type and send — prepare only', phase: 'prepare-only', zh: '长按消息「{quote}」→ 选「引用 / 回复」→ 键入「{text}」并发送（会真的发出一条消息）' },
  { name: 'teamily.tapRewrite', schema: z.object({ timeoutMs: z.number().int().min(1000).max(10_000).optional() }), input: { timeoutMs: 'max wait for the rewrite (default 10000)' }, doc: '收起键盘 → 点 AI 改写（chat.rewrite）→ 用像素变化等改写完成（≤10 s，超时 = 偏离）', description: 'Hide keyboard, tap AI rewrite, wait (pixels) until the screen settled (≤ 10 s)', phase: 'any', zh: '收起键盘，点 AI 改写按钮，等改写结束（≤ 10 秒）', serverDependent: '改写结果由服务端 AI 生成：是否替换原草稿、替换率随服务端变化' },
  { name: 'teamily.tapSend', schema: z.object({}), input: {}, doc: '发送输入框里已有的内容（App：收起键盘 → 点发送）', description: 'Send what is in the composer', phase: 'any', zh: '点发送，把输入框里的内容发出去（会真的发出一条消息）' },
  { name: 'teamily.freezeMention', schema: z.object({ member: z.string().min(1), as: z.string().min(1) }), input: { member: 'member display name in the @ picker', as: 'target id to freeze the row as' }, doc: '键入 @ → 按文字（① 无障碍）定位选择器里的成员行 → 冻结为目标 → 关闭选择器并清空（只在 prepare 用）', description: 'Open the @ picker, locate a member row by text, freeze it as a target — prepare only', phase: 'prepare-only', zh: '键入 @，在成员选择器里按文字找到「{member}」这一行并记下位置，然后关闭选择器、清空输入框' },
];

export const nodeSpec = (name: string) => NODE_SPECS.find((n) => n.name === name);
