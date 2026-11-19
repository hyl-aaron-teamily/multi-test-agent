---
name: plan-authoring
description: How the model reads an Issue and designs its test case from scratch, every time — quote the Issue, state the understanding and the oracle, compose the plan from SKILL building blocks only, and deliver a JSON envelope the validator and the warm-up round can check. Plans are judged by executability and reproduction rate; a plan that does not reproduce is revised from its run evidence. Loaded into the planner prompt together with the app SKILL's block catalog (teamily: vocab.ts / node-specs.ts / observe.ts).
version: 2026.11.05-2
---

# 计划编写 SKILL（Issue → 可执行、可审计、能复现的测试用例）

本 SKILL 规定**模型**怎样读 Issue、用积木设计测试用例、交付什么格式，以及计划没能复现时怎样修订。

**前提**：放进本地 `issues/` 的 Issue 都是**未解决、可复现**的问题。计划的任务就是把问题复现出来。没能复现，首先说明计划本身有问题（对象选错、触发不对、观察的位置不对、检查没有区分度），而不是说明产品没问题。

**每份 Issue 都从零设计用例**：不套用任何现成的计划，也不参考别的 Issue 的计划。能复用的只有积木。

## 1. 评价标准

计划的好坏只看两件事：

| 标准 | 怎么量 | 数据来源 |
|---|---|---|
| **可执行性** | 能否通过结构校验；预热轮是否走通（每个前置 `expect` 都成立、目标满足 `must`、基线成立、现象检查在基线状态下判「不通过」）；循环中的偏离率 | 校验器、预热轮、运行统计 |
| **复现率** | 命中次数 ÷ 有效尝试次数（附 Wilson 区间）；每次命中都要经过证据复核，确认与 Issue 描述的现象一致 | 运行结果 |

计划不可执行，就得不到复现率；可执行但复现率为 0，就要修订（§6）。

## 2. 工作顺序

1. **摘原文**：Issue 原文每行前面有行号 `L<n>`。摘关键片段时只写行号范围（`"lines": "L12-L14"`），编号为 `q1`、`q2`…；执行器按行号取出原文，所以摘录一定逐字，不要抄写原文。至少要摘到：被操作的对象、触发动作、异常现象、预期结果、频率、平台；Issue 里有对照（比如「文字消息正常」）也要摘出来。只能摘原文，不改写。
2. **写理解**（`understanding`）：一句话说清**谁**（对象）在**做了什么**（触发）之后出现了**什么**（现象），并标明依据的片段编号。
3. **拆子用例**：一个 Issue 报告了几个互相独立的问题，就拆成几个子用例；Issue 给了对照的，加一个 `control` 子用例。
4. **找积木**（§3）：把对象、触发、观察分别对应到积木上。**对应不上，就停下来写进 `feasibility.missing`**（R8），不要拿接近的积木凑数。
5. **写判定依据**（`oracle`）：先写清什么算命中、正常时检查会看到什么、有毛病时检查为什么一定会失败、触发前的基线是什么状态，再去写检查本身。
6. **搭计划**（§5）。
7. **自查**：逐条对照 §4 的硬规则检查一遍再交付。结论不用写出来（不再有 `selfCheck`）：结构规则由校验器检查，没过会把出错位置退回给你，只改那几处。

## 3. 积木

积木目录由执行端代码生成，在提示词里附在本文之后（「积木目录」一节）。**目录里没有的 id、Node、元素、观察，一律不能用。**

| 类 | 是什么 | 来源 | 用法要点 |
|---|---|---|---|
| 动作原语 | `tap` `longPress` `type` `key` `swipe` `scroll` `back` `wait` `launch` `exitApp` `killApp` `reload` `idle` `require` | `platform/schema/test-plan.ts#PlannedActionZ` | 只能指向元素 id 或 `target.<id>`，不写坐标；`delayAfterMs` ≤ 1000；生命周期动作只能用在 android-app / android-web |
| Node（组合动作） | 例如 `teamily.openConversation`、`teamily.sendMessage`、`teamily.quoteReply` | `skills/<app>/node-specs.ts` | `phase: prepare-only` 的 Node 只能放在 `prepare` 里；会发消息的 Node 只能用于允许清单里的会话 |
| 固定元素 | 例如 `chat.composer`、`chat.back`、`nav.chat` | `skills/<app>/vocab.ts#ELEMENTS` | 注意每个元素适用哪些端 |
| 参考区域 | 例如 `chat/composer`、`mention-picker/picker` | `vocab.ts#REGIONS` | 用于 `visual-region` 检查 |
| 动态目标 | 准备阶段由模型按说明选定，然后冻结成坐标 | `targets[]` | 必须写 `must`（§5.3），把 Issue 对对象的硬性要求写成机器能核对的条件 |
| 观察 | `text`、`keyboard`、`process-alive`、`visual-region`、`crash`、`ai`… | `engine/observe.ts#OBSERVATIONS` | 优先用 ① 确定性的观察（无障碍文字、系统状态、区域比对）；`ai`（视觉）只在 ① 观察不到时用 |
| 动作后置条件 | 某个动作做完后**马上**读一次 ①，确认画面变成了预期的样子 | `expect`（§5.2） | 现象就发生在某一步之后的，必须用它在那一步观察（R4） |
| 前置构造 | 在允许清单里的会话中造数据（发消息、引用回复） | `prepare` + `prepareCheck` | 构造的文字里要带 `{token}`；只对测试账号自己的内容做社交动作 |

## 4. 硬规则

「校验器」= 机器结构校验（`issue/validate.ts`），不通过就退回模型重写；「预热」= 进循环前实际跑一轮，不通过就判「计划不可执行」；「自查」= 模型交付前自己对照检查（不输出）。

| # | 规则 | 执行者 |
|---|---|---|
| R1 | 只用积木目录里的 id；不写坐标、不写代码 | 校验器 |
| R2 | **对象一致**：触发作用的目标就是 Issue 说的对象。对象的类型、发送者、内容形态都写进 `target.must`，而且要和 `understanding.subject` 一致 | 校验器（`must` 齐全）+ 预热（目标核对）+ 自查 |
| R3 | **触发一致**：动作序列里包含 Issue 的触发动作本身，不能用这个触发之后的下游操作来代替触发 | 自查 |
| R4 | **在现象发生处观察**：现象是「做完动作 A 之后，X 没出现 / 出错」的，就给 A 加 `expect`（`role: phenomenon`）；不能等后面还有别的动作的轮末再检查 | 校验器（`oracle.at` 指向一个带 `expect` 的动作，或者写明理由）+ 自查 |
| R5 | **检查有区分度**：<br>① 有毛病时一定失败，正常时一定通过；<br>② 范围取最窄：有消息锚点用 `{message}`，有目标用 `{target}`，最后才用整屏；<br>③ 匹配的内容不能是触发界面自己带的东西（例如菜单里本来就有的 👍）；<br>④ 会留存的状态（反应、标记、草稿）必须写 `baseline` | 校验器 + 预热（基线状态下现象检查必须判「不通过」） |
| R6 | **每轮复位并核实**：一轮改变了的状态，`afterCheck` 要恢复，并且给复位动作加 `expect`（`role: precondition`） | 校验器 |
| R7 | **对照**：Issue 给了对照的，加 `control` 子用例：同样的动作，换成对照对象。对照组还能证明检查在正常时会通过 | 自查 |
| R8 | **缺口要明说**：需要的积木不存在时，`feasibility.status = needs-block`，在 `missing` 里写清需要什么、为什么需要（引用片段编号）。不允许用别的积木近似顶替 | 自查 |
| R9 | **替代执行**：换了端执行的，写明现象的哪些部分在新端上可能不一样 | 自查 |
| R10 | **执行约束**：<br>循环里只用 `phase: any` 的 Node；`prepare-only` 只放在 `prepare`；<br>发消息只发到允许清单里的会话；循环里不发打扰他人的消息；<br>社交动作只对测试账号自己的内容做；<br>`delayAfterMs` ≤ 1000 | 校验器 |
| R11 | **标题说的是这条 Issue**：用 Issue 的对象和现象来命名，例如「长按纯链接消息：菜单是否弹出」 | 自查 |
| R12 | **全部可追溯**：每个目标、动作、检查、`expect` 都要在 `trace` 里引用片段编号，或者写 `executor:<理由>`（例如进入会话、复位）；`quotes` 里的每一段都必须能在 Issue 原文里逐字找到 | 校验器（逐字比对原文） |

## 5. 交付格式

只输出**一个** JSON 对象，不要输出 Markdown 或解释文字。

### 5.1 外层

```jsonc
{
  "quotes": [{ "id": "q1", "lines": "L12-L14" }],
  "understanding": {
    "subject": "被操作的对象",
    "trigger": "触发动作",
    "phenomenon": "异常现象",
    "expected": "正常时应该是什么样",
    "frequency": "always | intermittent | unknown",
    "control": "Issue 给出的对照；没有就写空串",
    "basis": ["q1", "q3"]
  },
  "feasibility": {
    "status": "plannable | needs-block | unconstructible",
    "missing": [{ "kind": "node | element | target | observation | precondition", "need": "需要什么", "basis": ["q2"] }]
  },
  "subcases": [
    {
      "sub": "main | control | s1 | …",
      "oracle": {
        "at": "actions[0]",
        "hit": "一句话：什么算命中",
        "normal": "正常时检查看到什么",
        "canFail": "有毛病时，检查为什么一定会失败",
        "baseline": "触发前的状态，以及怎么确认"
      },
      "plan": { "…": "§5.2" },
      "trace": [{ "at": "targets.<id>", "basis": ["q1"] }, { "at": "actions[1]", "basis": ["executor:复位"] }]
    }
  ],
  "revision": null,
  "risks": ["需要人留意的不确定性，最多 3 条，每条一句话"]
}
```

`revision` 只在修订时填（§6）。`quotes` 也可以写 `text`（逐字原文），但优先写行号。

首次设计分两段：第一段只交 `quotes`、`understanding`、`feasibility` 和要用的积木名（`blocks`），不可执行就到此为止；第二段只交 `subcases` 和 `risks`，系统提示里只附选中积木的完整规格。校验没过时，系统只把出错的子用例和错误位置发回来，回答 `{ "ops": [...] }`（JSON 指针，子用例按名字定位），不要重交整份计划。

### 5.2 `plan`

字段以 `platform/schema/test-plan.ts#TestPlanZ` 为准。下面这些字段由执行器填写，模型**不要**写：`id`、`issueRef`、`category`、`surface`、`env`、`limits`、`verdictRule`、`provenance`。

```jsonc
{
  "title": "<对象 + 现象>",
  "targets": [{ "id": "…", "kind": "…", "guidance": "…", "afterPrepare": true,
                "must": { "sender": "self", "content": "link", "contains": "{token}" } }],
  "setup": [ /* 进入场景，例如打开会话 */ ],
  "prepare": [ /* 构造前置条件，只跑一次 */ ],
  "prepareCheck": { /* 前置条件确实存在 */ },
  "baseline": [ /* 每轮触发前读一次 ①；不成立 = 这一轮偏离，不计有效尝试 */ ],
  "actions": [
    { "type": "…", "element": "target.…", "delayAfterMs": 900,
      "expect": { "role": "phenomenon", "check": { /* ① 观察 */ } } }
  ],
  "checks": [ /* 轮末检查；现象已经由 expect 观察的，这里可以为空 */ ],
  "afterCheck": [ /* 复位动作，带 expect(role: precondition) */ ]
}
```

- `expect.role = phenomenon`：读到的结果就是判定。检查不通过 = 命中，然后走证据复核。
- `expect.role = precondition`：读到的是中间状态。检查不通过 = 这一轮偏离，不计有效尝试。
- `expect.check` 只能用 ① 观察（`text` / `keyboard` / `process-alive` / `visual-region`），并且要在动作间隔内读完（无障碍读取的 p95 ≈ 0.5 s）。需要视觉才能判断的现象，放到轮末的 `checks` 里用 `ai`。

### 5.3 `target.must`

| 字段 | 取值 | 怎么核对 |
|---|---|---|
| `sender` | `self` / `others` / `any` | 准备阶段读树：气泡在左还是在右、发送者名称 |
| `content` | `text` / `link` / `image` / `card` / `any` | 读树：文字是否整段匹配 URL；有没有图片节点 |
| `contains` | 字面文字，可以用 `{token}` | 读树 |

选中的目标核对不通过就重选；连续 3 次不通过，判执行失败。不允许用视觉模型的「看起来像」放行。

## 6. 修订（计划没能复现时）

触发修订的情况：预热不通过（不可执行）、偏离率超过阈值、或者在预算内一次都没命中。执行器把下面这些材料交回模型，模型交出新版本的外层 JSON，并填写 `revision`：

**交给模型的材料**：上一版的外层 JSON；预热每一步的结果；`expect` / `baseline` 每次失败的记录（哪一步、读到了什么）；偏离的原因；定期采样的截图；命中次数和有效尝试次数。

```jsonc
"revision": {
  "from": "v1",
  "evidence": ["预热第 1 步：目标核对 must.content=link 不通过（选中的是文字消息）", "…"],
  "diagnosis": "上一版为什么没能复现（对象 / 触发 / 观察位置 / 区分度 / 环境替代 / 缺积木）",
  "changes": ["改了什么，以及每一处改动对应哪条 evidence"]
}
```

- 每一处改动都要对应到证据；没有证据支持的改动不做。
- 诊断结论是「缺积木」或「环境替代导致无法复现」的，不再修订，结论写明原因。
- 修订次数有上限（W3-1 定为 3 版）。每一版的复现率都记进报告。
