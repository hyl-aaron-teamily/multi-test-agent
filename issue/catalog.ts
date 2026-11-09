// Block catalog (W3-1 §7.1): everything a model-authored plan may reference, generated from the code that
// executes it — action types (PlannedActionZ), Nodes with their phase (node-specs.ts), fixed elements and
// reference regions with their surfaces (vocab.ts), target kinds, observations (observe.ts). The planner
// prompt is plan-authoring/SKILL.md + this catalog; the validator checks plans against the same lists.
import { z } from 'zod';
import { APP_SURFACES, CheckPointZ, EXPECT_KINDS, PlannedActionZ, SURFACES, TargetMustZ } from '../platform/schema/test-plan';
import { OBSERVATIONS } from '../engine/observe';
import { NODE_SPECS } from '../skills/teamily/node-specs';
import { ELEMENTS, REGIONS, SKILL_VERSION, TARGET_GUIDANCE } from '../skills/teamily/vocab';

export const ACTION_TYPES = PlannedActionZ.shape.type.options;

/** Nodes that post a message (allow-listed conversations only, R10). */
export const POSTING_NODES = new Set(['teamily.sendMessage', 'teamily.quoteReply', 'teamily.tapSend']);

/** Target kinds the preparation stage knows how to pick (rows by reading the list, others by locating). */
export const TARGET_KINDS: Record<string, string> = {
  ...TARGET_GUIDANCE,
  conversation: '会话列表里的一个会话（guidance 写明怎么认，如 titled "<名称>"；构造数据只能用允许清单里的会话）',
  'quote-card': '聊天里一条引用回复上的引用块（Android：取最下面一个不含链接的）',
  message: '聊天里的一条消息（guidance 写清哪一条；must 写明发送者 / 内容形态 / 包含的文字）',
};

/** Pure: the catalog as prompt text (Chinese headings, ids verbatim). */
export function blockCatalog(): string {
  const out: string[] = [`# 积木目录（SKILL ${SKILL_VERSION}，由执行端代码生成）`, ''];
  out.push('## 端', SURFACES.join(' / ') + `（生命周期动作 exitApp / killApp 只能用在 ${APP_SURFACES.join(' / ')}）`, '');
  out.push('## 动作原语（PlannedAction.type）', ACTION_TYPES.join(' '), '- `element` 只能是下面的固定元素 id 或 `target.<目标 id>`；`delayAfterMs` 0–1000；`wait` ≤ 1000 ms；`idle` 用 value 写毫秒（≤ 600000）', '- 文本里可用 `{token}`（本次运行标记）和 `{round}`（轮号）', '- 不要写 `launch` 和登录：执行器负责冷启动、登录，开始时停在首页会话列表；setup 从这里进入场景', '');
  out.push('## Node（type: "node", node: { name, input }）');
  for (const n of NODE_SPECS) if (n.name !== 'teamily.login') out.push(`- \`${n.name}\` [phase: ${n.phase}] 输入 ${Object.keys(n.input).length ? Object.entries(n.input).map(([k, v]) => `${k}=${v}`).join('; ') : '无'} — ${n.doc}${POSTING_NODES.has(n.name) ? '（会发消息：只能用于允许清单里的会话）' : ''}`);
  out.push('', '## 固定元素（element）');
  for (const e of ELEMENTS) out.push(`- \`${e.id}\` [${e.surfaces.join('/')}] ${e.page} 页：${e.meaning}`);
  out.push('', '## 参考区域（visual-region 检查：page + region）');
  for (const r of REGIONS) out.push(`- \`${r.page}/${r.region}\` ${r.meaning}`);
  out.push('- 写法：page 和 region 分开，例如 {"kind":"visual-region","page":"mention-picker","region":"picker"}', '- 也可写 region `element:<固定元素 id>`（该元素在 / 不在）', '');
  out.push('## 动态目标（targets[].kind）');
  for (const [k, v] of Object.entries(TARGET_KINDS)) out.push(`- \`${k}\` ${v}`);
  out.push('- 每个目标都要写 `must`：sender = self | others | any；content = text | link | image | card | any；contains = 字面文字（可用 {token}）', '');
  out.push('## 观察（CheckPoint.kind）');
  for (const [k, v] of Object.entries(OBSERVATIONS)) out.push(`- 观察 \`${k}\`：${v.meaning}；① 确定性通道：${v.tier1.join('/') || '无（只能视觉）'}`);
  out.push(
    '- CheckPoint.kind 取值：visual-region / crash / process-alive / console-error / page-error / ai / baseline / keyboard / text',
    `- \`expect.check\` 只能用 ①：${EXPECT_KINDS.join(' / ')}`,
    '- text 检查必须写 match（exact / contains / regex）；scope：screen | composer | quote-cards | {target, within, withinX} | {message: <锚点文字>} | {targetBubble: <目标 id>}（目标消息的气泡 + 它下面的反应行）',
    '- want: present（默认）| absent',
    '',
    '## 字段格式（JSON Schema，逐字遵守）',
    `- PlannedAction：${schemaOf(PlannedActionZ)}`,
    `- CheckPoint（checks / baseline / prepareCheck / expect.check）：${schemaOf(CheckPointZ)}`,
    `- targets[].must：${schemaOf(TargetMustZ)}`,
    '- 例：一个文字检查对象写成 {"kind":"text","expect":"菜单弹出","match":{"contains":"回复"},"scope":{"targetBubble":"msg"}}——match 是对象，不是字符串；要找的文字写在 match 里，expect 只写这条检查的意思',
  );
  return out.join('\n');
}

/** Compact JSON Schema of a zod type (input side: defaults are optional). */
function schemaOf(t: z.ZodType): string {
  const j = z.toJSONSchema(t, { io: 'input' }) as Record<string, unknown>;
  delete j.$schema;
  return JSON.stringify(j);
}
