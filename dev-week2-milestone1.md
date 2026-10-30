# 里程碑 W2-1（第六版）：意图契约 + 循环外分层观察/定位 + 预热闸门 + 执行基座重构

> 来源：一份外部方案（「行为契约两阶段生成」+「UIAutomator → 本地嵌入 → 视觉 三层定位」+「预热固化 / 压力回放」）。
> 2026-10-26 读代码与实测核对后，经两轮澄清与一次最终确认定稿。本里程碑**先重构基座、再加功能**：P0 行为不变的整合重构 → P1 观察库与分层 → P2 契约两阶段 → P3 预热闸门 → P4（可选）轨迹记录接入 TencentDB Agent Memory。

---

## 0. 现状基线（读代码 / 实测核实，2026-10-26）

| 项 | 现状 | 依据 |
|---|---|---|
| Issue 主线循环 | **已是坐标驱动**：准备阶段选目标并冻结坐标 → 循环只按坐标操作；1594 跑 1000 步，最大间隔 918 ms，视觉调用 0 次；1329 s2 跑 268 轮，视觉调用 0 次 | `executor/run.ts:221-282`、`docs/m5-acceptance.md:27`、`midscene_run/issues/*/result.json` |
| 每步都调视觉的入口 | 只有 mission（自然语言任务）用 `aiAct`，单步 3–160 s | `mission/runner.ts:307-335`、`CHANGELOG.md:93` |
| 真正的吞吐瓶颈 | **每轮用视觉模型当判定器**（`ai` 类检查）：1329 s1 点赞 30 分钟 186 轮，视觉调用 375 次（9.7 s/轮）；s3 键盘 210 轮，视觉调用 425 次（8.6 s/轮）；对照 1594 区域比对 3.7 s/轮，视觉 0 次。开发期由视觉判定的几次「已复现」事后都被证伪 | 本地运行统计；`docs/m6-acceptance.md` §1 |
| 读 Android 界面树的成本 | `uiautomator dump + cat` 在 4f2ebdf2 上实测 **2.6–3.7 s/次**（imui 文档记约 3 s）；`dumpsys input_method` 120–180 ms；`screencap` 470–560 ms | 2026-10-26 实测；`docs/imui.md:82` |
| 计划的语义误差 | 2044（引用块把 Markdown 源码原样显示）降级到通用模板：在群里循环发 `autotest ping`、只检查崩溃——永远观察不到 Issue 描述的现象，必现规则下会得出「未复现（疑似已修复）」的误导结论；1329 s2 的 mobile-web 计划同样落到了通用模板 | `platform/plans/drafts/2044.json`、`platform/plans/1329-s2-mobile-web-v1.json` |
| 确认的计划 ≠ 执行的计划 | `run --issue` 每次重新生成草稿（再调一次模型）；控制台只确认子用例编号；`platform/plans/*.json` 只写不读 | `issue/cli.ts:24-27,101-105` |
| Midscene 定位缓存 | Android 端没有元素定位缓存（`cacheFeatureForPoint`）；Web 有 | M5 §0 |
| 工程基座 | `runPlan` 一个函数 458 行；读界面树的实现有 7 处（3 处带重试，多处共写 `/sdcard/autotest_ui.xml` 且没有锁）；Midscene agent 构造 3 处；OpenAI 兼容请求 3 处；投票逻辑 2 处；租用 → 启动 → 登录 → 回首页在 run / sync / replay 各写一遍；Node 清单 3 处；profile 命名 7 处；Surface 类型 2 处；issue ↔ executor ↔ incident 存在包级循环依赖；executor、skills 依赖 imui 的 `parseNodes` | 重构热点扫描（见 §3 P0） |
| 测试 | `typecheck` 通过；`test:unit` 78/78（11 个文件）。`runPlan`、`execAction`、`targets.ts`、判定函数、驱动、`skills/*` 都没有单测；`tests/android/logcat-monitor.unit.spec.ts` 在 android 项目里，CI 的 unit 步骤跑不到 | `vitest.config.ts:44` |
| 设备 | Xiaomi 2211133C（4f2ebdf2，Android 16，`ai.teamily.mobile` 2.0.15）在线；Node 22.23.2，pnpm 12.4.2 | `adb devices -l` |

---

## 1. 方案评价与澄清结论

### 1.1 对外部方案的核对

| 方案论断 | 结论 |
|---|---|
| 「现在每一步点哪里都由 Midscene 看截图决定」 | ✗ Issue 主线自 M5 起就按坐标执行，循环中 0 视觉。只有 mission 入口是每步视觉 |
| 「第①层精确匹配 1–2 ms」 | ✗ 1–2 ms 只是匹配本身；本机读一次界面树要 2.6–3.7 s。每步都读，会直接打破「动作间隔 ≤1 s」 |
| 「①② 层覆盖 90% 定位需求」 | 未验证。Teamily 的发送键、各处铃铛都没有文字，①② 层对图标按钮无效 |
| bge-small-zh「15MB」、阈值 0.62、「故障发现率 54.9%」 | 外部数字，本项目无数据支撑，不作为验收依据 |
| Midscene Android 没有元素定位缓存 | ✓ |
| 「预热固化坐标、压力纯回放」 | 主体已有（准备 → 冻结 → 循环）；**缺的是预热轮逐步核验 + 失败回传规划的闸门** |
| 「校验失败降级到模板」 | 已有；但降级产出的计划可能观察不到 Issue 现象（2044） |

**重述**：两个问题在「观察库」交汇——契约里的可观察后置条件必须能对应到观察库中的某种判定方式（问题一）；观察库内部按「确定性优先，视觉兜底」排序（问题二）。三层思想用在**每轮判定**和**准备期 / 标定期 / 自愈时的定位**，**不进循环**。

### 1.2 澄清结论（用户决定）

| # | 问题 | 决定 |
|---|---|---|
| D1 | 分层放在哪 | 只在循环外：每轮检查点判定、准备期 / 标定期定位、漂移时按指纹重新定位；预热轮允许逐步核验（慢，只跑一轮）。循环仍只按坐标操作，≤1 s，0 视觉 |
| D2 | 第②层本地嵌入模型 | 本期只留接口（`Ranker` 插槽，默认空实现）；报告记录 ① 层命中率与 ③ 层调用次数，下期按数据决定 |
| D3 | 契约 / 计划校验失败的降级 | **保持现状**（通用模板兜底）。只加一条报告标注：兜底计划对应不上契约的可观察后置条件时，结论旁注明「计划未覆盖 Issue 现象，仅说明无崩溃」；计划与判定规则不变 |
| D4 | Web 端只读观察 | 准备期、预热轮、每轮检查点可只读无障碍快照 / DOM 文本（Playwright 定位器读取，不 `evaluate`、不改页面）；循环每步不读 |
| D5 | 生产环境构造前置条件 | 允许，但只在「全员都是池账号 / 用户本人的会话」或自己的 Personal AI 会话里；允许清单放本地私有文件；构造出的消息不撤回 |
| D6 | 读系统状态做判定 | 允许，与 pidof / logcat / 前台 Activity 同级（如 `dumpsys input_method` 的 `mInputShown`） |
| D7 | 范围 | P0–P3 全做；削减线：P4 先砍，其次 P3 的指纹自愈 |
| D8 | 遗留代码 | 删除无入口的死代码与未用导出；mission / explore / monkey / imui 与 week-1 的 package.json 脚本入口保留，行为不变 |
| D9 | 腾讯记忆项目 | 本期定轨迹格式 + `TrajectorySink` 接口 + 本地 JSONL 默认实现；TDAI `session/add` 适配作为 P4 可选（默认关闭，削减线先砍） |

---

## 2. 原则（继承 M5，按 §1.2 修订）

1. **黑盒**：不读源码、不装调试版、不注入页面代码（不 `page.evaluate` / `addInitScript` / `exposeFunction`）、不连调试端口、不依赖 App 内部钩子。只读观察允许：Android 无障碍树、系统状态（logcat / pidof / dumpsys 中用户可见的状态）、Web 无障碍快照 / DOM 文本（D4、D6）。
2. **准备时 AI，循环时确定性**：循环只按坐标操作；**界面树、DOM 文本、视觉都不进循环的每一步**。每轮检查点可读界面树 / 系统状态 / 无障碍快照，耗时不计入动作间隔（M5 §C.2 口径不变）。
3. **判定确定性优先**：每种判定先走确定性方式，视觉只在确定性方式不可用或结果有歧义时兜底；每次判定都记录由哪一层得出、耗时多少。
4. **理解只发生在生成阶段**：Issue → 契约（理解）→ 计划（组合）。执行器不再解读 Issue 文本；证据复核对照的是契约的可观察后置条件。
5. **确认即冻结**：用户确认的计划就是执行的计划，内容可复核（哈希），执行时不再调模型重新生成。
6. M5 其余原则不变：动作间隔 ≤1 s；一份 Issue 只启动一次 App；偶现命中 1 次 / 必现连续 3 次；替代执行在开始时一次性确认；结论以生产环境为准；凭据只在本地私有文件。

---

## 3. P0：执行基座整合重构（行为不变）

目标：不改变任何对外行为，把重复实现收敛成一处、把超长函数拆开、补上核心模块的单测，为 P1–P3 提供落点。**每个子项完成后跑回归门（§3.9），回归通过再提交。**

### 3.1 统一 Android 界面树读取：`core/ui-tree.ts`
- 只保留一个读取实现：按设备串行（加锁）、轮换文件名、UI 不空闲时重试、记录每次耗时。`parseNodes` 与节点类型从 `imui/clients/android.ts` 移入，imui 改为从这里导入。
- 查询函数：按文字 / desc 精确或子串匹配、限定区域、找可点击的祖先节点、取中心点。
- 替换现有调用：`executor/targets.ts`（4 处）、`executor/sync.ts:302`、`skills/calibrate-android.ts:26`、`skills/calibrate-android-web.ts:46`、imui 自带的读取。
- 改正注释与事实不符的地方：`calibrate-android.ts:1` 写着「运行时不读界面树」，实际 `run.ts:411`（基线检查）和 sync 每次核对都在读——改为写明读取发生在哪些阶段。

### 3.2 统一模型调用：`core/model/`
- 一个 OpenAI 兼容客户端（`chatJson` / `visionJson`）与唯一的调用计数（按用途分：计划、准备、检查点、证据复核、预热、标定、同步核对）；`extractJson` 从 `mission/planner.ts` 移出，mission 改为从这里导入。
- Midscene agent 工厂按驱动缓存（`visionAsk`、`visionLocate` 共用）；替换 `executor/checks.ts:158`、`executor/targets.ts:215`（现在每次定位都新建 agent 并 `connect()`）、`skills/calibrate-android-web.ts:60`。
- 多数投票工具共用（`checks.ts:132`、`evidence-review.ts:199`）。

### 3.3 执行会话与端适配器：`executor/session.ts` + `executor/surfaces/*`
- `SurfaceSession`：租用（账号 + 槽位，带重试）→ profile → Web 会话 → 驱动与飞行记录器 → 启动 → 等首屏 → 移动 Web 下载横幅 → android-web 按需登录 → SKILL 有效性检查与回首页 → 手机端先点「聊天」tab → 清空启动噪声。
- 端适配器 `android-app.ts` / `android-web.ts` / `web.ts`：收纳目前散落在 `run.ts:181-218,243-262`、`sync.ts:225-246`、`nodes.ts:56-123`、`planner.ts` 中的端特例（回首页路径、返回方式、发送方式、键盘处理）。
- `run.ts`、`sync.ts`、`incident/replay.ts`、`scripts/m5.ts`（smoke / lifecycle）改用同一会话；`toChatListAndroidWeb`、`waitPastDialog` 移进 android-web 适配器；HARD 异常类型只定义一处。

### 3.4 拆分 `runPlan`
- 拆成 `executor/prepare.ts`（目标、setup、prepare、prepareCheck）、`executor/loop.ts`（轮次、看门狗、异常门、afterCheck）、`executor/checkpoint.ts`（检查评估、偏离判断、基线）、`executor/incident-hook.ts`（现场包 + 证据复核）、`executor/stats.ts`（间隔统计）。`runPlan` 只负责编排，目标 ≤150 行。
- `execAction` 移入 `executor/actions.ts`，配假驱动单测。

### 3.5 单一来源与依赖清理
- Node：`vocab.ts` 的 `NODES`、`nodes.ts` 的 `NODE_SCHEMAS` 与 `DESCRIPTIONS` 合并为一张表（名称、输入 schema、说明、执行阶段 `phase: 'any' | 'prepare-only'`，见 §5.4）。
- Surface 类型只在 `platform/schema/test-plan.ts` 定义；profile 命名只用 `profileKey`（删除未使用、格式不同的 `profile.ts#profileName`；`incident/replay.ts:85` 不再用正则从 profile 名反推序列号）；Teamily 包名只定义一个常量；`issuePath` 只保留一份（`issue/paths.ts`）。
- 打破包级循环：`incident/evidence-cases.ts` 不再导入 `issue/cli`；`issue/llm`（计数器）不再被执行层反向依赖（随 3.2 迁到 `core/model`）；`platform/accounts/ui-login.ts`、`sessions.ts` 不再向上导入 executor / skills（登录流程移到端适配器或 SKILL 层）。
- 标定公共部分（`put` / `selfCheck` / `ref`）抽到 `skills/calibrate-common.ts`，三个标定器共用。

### 3.6 计划模板 → SKILL 模式库（golden 保证不变）
- 先把现有 `templateFor` 对「10 份 Issue × 各端」的产出存成 golden 文件（`issue/__golden__/`），再把 6 个模板 + 生命周期模板（现只在 `scripts/m5.ts:103-154`）迁到 `skills/teamily/patterns/`（结构见 §5.2）。迁移后由模式库生成的计划须与 golden 逐字段相等。
- 判断「模板是否具体」改为看模式 id，不再比较标题字符串（`planner.ts:248`）；`plan-template.md` 由模式库的元数据生成或与之对照校验。

### 3.7 确认即冻结（修复）
- 草稿带内容哈希（含契约与各子用例计划）和 Issue 文件哈希；控制台确认时提交草稿哈希，CLI 显示哈希。
- `run --issue` 默认复用已有草稿（Issue 文件未变时），`--redraft` 才重新生成；批准后的计划写入 `platform/plans/<plan-id>.json`（含 `confirmedAt`、`draftHash`），**执行器读这些文件执行**。
- 草稿与确认不一致（哈希对不上）时拒绝执行并提示重新确认。

### 3.8 小修与死代码
- 控制台 approve 校验加上 `android-web`（`platform/tasks.ts:73`）。
- `executor/sync.ts:107` 的默认会话（含账号邮箱与真名）移到本地私有配置（与 D5 的允许清单同一文件，见 §5.5）。
- `tests/android/logcat-monitor.unit.spec.ts` 移入 unit 项目（CI 能跑到）。
- 删除未使用的导出 / 导入：`profile.ts#profileName`、`targets.ts#isRowTarget`、`checks.ts#regionDistance` 与 `MATCH_DISTANCE`、`nodes.ts#nodes`、`vocab.ts#elementIds/nodeNames`、`run.ts` 中未用的 `hamming` 等（以删除时 grep 为准）。week-1 脚本、mission / explore / monkey / imui 入口保留。
- `replay/screen-recorder.ts` 被 incident 使用，移到 `incident/` 或 `core/`；`replay/ops.ts` 与 `scripts/replay.ts` 仍服务 mission 重放包，保留。

### 3.9 P0 单测与回归门
- 新增单测：`core/ui-tree`（解析、查询、锁）、`executor/actions`（假驱动）、`checkpoint`（`evaluateVisual` 用参考图夹具）、端适配器纯函数、模式库 golden、确认哈希。
- **回归门**（P0 完成时，以及之后每个阶段结束时都跑）：`pnpm typecheck`；`pnpm test:unit`；`pnpm test:web`；`pnpm test:android`；`pnpm autotest evidence cases` 2/2；四个执行端 `skill smoke`；`skill smoke --surface android-app --lifecycle cold`；1594 desktop-web 20 轮；1329 s2 android-app 20 轮；`sync` 三端 1 轮。结论与统计口径须和 M5 / M6 一致（行为不变）。

---

## 4. P1：观察库 + 循环外分层（问题二）

### 4.1 观察库：`skills/teamily/observations.ts` + `executor/observe/`
每种判定声明它在各个执行端上的**通道链**，执行时按顺序尝试，第一个给出确定结论的通道定案：

| 层 | 通道 | 典型耗时 |
|---|---|---|
| ① 确定性 | logcat / 页面事件、`pidof`、系统状态（`dumpsys input_method` 等）、Android 无障碍文字、Web 无障碍快照 / DOM 文本、参考区域比对 | 0–3.7 s（读界面树最慢） |
| ② 排序（插槽） | `Ranker` 接口，本期为空实现 | — |
| ③ 视觉 | Midscene `aiBoolean` / `aiLocate`、`visionJson`（多数投票） | 秒级 |

观察条目（首批）：

| id | 含义 | android-app | android-web | mobile-web / desktop-web |
|---|---|---|---|---|
| `crash` / `anr` / `process-death` | 闪退 / 无响应 / 进程死亡 | ① logcat | ① logcat | ① 页面事件 |
| `process-alive` | 进程存活 | ① pidof | ① pidof | — |
| `keyboard-shown` | 软键盘弹出 | ① `dumpsys input_method` mInputShown | ① 同左 | ③（mobile-web 是模拟器，没有真软键盘：不可用于判定，计划校验拒绝） |
| `region` | 参考区域在 / 不在（现有 visual-region） | ① 区域比对 → 不一致才 ③ | 同左 | 同左 |
| `text` | 指定文字在 / 不在，可限定区域或某个目标附近（如引用块、某条消息下方） | ① 无障碍文字 → ③ | ① 无障碍文字（浏览器的无障碍树只在页面加载时建立，常不可用）→ ③ | ① 无障碍快照 / DOM 文本 → ③ |
| `quoted-original` | 点引用后落在被引用的原消息（现有 baseline） | ① 无障碍 + 像素 | ③ | ① 无障碍快照 / DOM 文本 → ③ |
| `element` | 某元素（如 🔔）存在 / 不存在 | ① 区域 → ③ | 同左 | ① 无障碍快照（role / name）→ 区域 → ③ |
| `visual-question` | 自由视觉问题（现有 ai） | ③ | ③ | ③ |

- CheckPoint schema 新增 `kind: 'keyboard' | 'text'`（`text` 带 `match: { exact | contains | regex }`、`scope: region | target`）；现有 kind 不变。
- 每次判定写入回合记录：`{observation, tier, ms, result}`；报告新增「判定分层统计」（各层次数、平均耗时、视觉调用按用途拆分）。
- 视觉兜底的判定照旧必须经过证据复核才算命中（M6 规则不变）。

### 4.2 分层定位服务：`executor/locate.ts`
- 输入：目标描述（元素含义 / 目标指引 / 契约里的文字）+ 可选的文字指纹；输出：`{point, box, tier, candidates, ms}`。
- 顺序：① Android 无障碍文字 / Web 定位器（`getByRole` / `getByText`，精确优先、再子串）→ ② `Ranker` 插槽 → ③ Midscene `aiLocate`。
- 接入：准备期会话内的目标（`others-text-message` 先读消息气泡文字，`like-action` 长按后读菜单文字）、下载 App 弹窗的「忽略」（`run.ts:596`）、android-web 标定中的临时元素（先 ① 后 ③）、sync 的可见性核对（Web 接收端走 ①；android-web 的无障碍树常不更新，按需走 ③）。
- **不接入循环**：循环中的 tap / longPress 仍用冻结坐标。

### 4.3 改造现有用例的判定
- 1329 s3（键盘）：android-app 的 `ai` 检查 → `keyboard-shown`（①）。
- 1329 s1（点赞）：**先在真机核实**点赞后无障碍树里是否出现可读的点赞标记（文字 / desc / 计数）。能读到 → 改为 `text`（①，限定在目标消息附近）；读不到 → 保持 ③，报告写明原因。
- sync：desktop-web / mobile-web 接收端改为 ① 读文字；android-web 记录每次核对用的是哪一层。

### 4.4 P1 验收
- 1329 s3 在 android-app 上生产环境跑满 15 分钟：循环与检查点的视觉调用 = 0（证据复核另计）；轮速 ≥ 基线 2 倍（基线 7.0 轮/分钟，来自 `1329-2026-10-21T12-51-17-047Z`，210 轮 / 30 分钟）；最大动作间隔 ≤1 s。
- 1329 s1：给出无障碍可读性的核实结论；可读时循环中视觉调用 = 0。
- sync 三端 3 轮：desktop-web 接收端的视觉核对 = 0，结果与 M6 一致（全部可见，或如实报告不可见）。
- 报告中出现「判定分层统计」，① 层命中率与 ③ 层调用次数可从报告读出（作为 D2 下期决策的数据）。

---

## 5. P2：Issue → 契约 → 计划 两阶段（问题一）

### 5.1 契约 schema：`platform/schema/contract.ts`

```typescript
interface IssueContract {
  issueRef: string;
  sub: string;                          // main | s1 | s2 …（沿用现有子用例拆分）
  preconditions: {
    id: string;                         // 前置条件库 id；库中没有则为 'unmapped'
    text: string;                       // 从 Issue 复述的前置条件
    establish: 'executor' | 'existing-data' | 'construct' | 'unconstructible';
  }[];
  trigger: {
    semantics: string;                  // 触发语义库 id（如 repeat-mention、tap-quote、view-quote-preview）
    text: string;                       // 复述：做什么、频率 / 间隔
    pattern?: string;                   // 命中的模式 id；未命中则留空
    params?: Record<string, unknown>;   // 模式参数（如构造用的消息模板）
  };
  observable: {
    observation: string;                // 观察库 id；对应不上则为 'unmapped'
    text: string;                       // 期望的正常表现（Expected）
    phenomenon: string;                 // Issue 描述的异常现象（Actual），证据复核按它对照
  };
  suspectedMechanism?: string;          // 推测，可为空；只作提示，不进入执行、不参与判定
  provenance: { by: 'rules' | 'model' | 'manual'; skillVersion: string; model?: string };
}
```

TestPlan 增加 `contract?: IssueContract` 与 `coverage: 'covered' | 'not-covered'`（计划的检查是否对应契约的可观察后置条件）；`provenance` 增加 `pattern?: string`。

### 5.2 SKILL 三个库（`skills/teamily/`）
- **前置条件库** `preconditions.ts`：id、含义、各端的建立方式——`executor`（已登录等）、`target:<kind>`（用已有数据，由准备阶段选，如成员 ≥3 的群）、`construct:<步骤>`（用 prepare 构造，只能在允许清单里的会话中进行，D5）、`unconstructible`（如写满浏览器存储、需要第二账号）。
- **触发模式库** `patterns/`：每个模式 = 触发语义 + 所需前置条件 + 观察 + 适用端 + 参数 schema + `build(params, surface) → 计划片段（targets / setup / prepare / prepareCheck / actions / checks / afterCheck / acceptance）`。首批 = P0 迁移来的 7 个模式（@ 选择器、引用跳转、键盘、点赞、生命周期热 / 冷、通知入口盘点、@我 聚合）+ 通用浏览（只配 `crash` / `page-error`），新增 `quote-preview-text`（2044）。
- **观察库**：§4.1。

### 5.3 两阶段生成
1. **阶段 1：Issue → 契约**（理解）。规则先给强信号（频率、平台、类别、明确的现象词），LLM 以 JSON Schema 结构化输出补全，只能使用三个库的 id 或 `unmapped`；`suspectedMechanism` 明确标注为推测。分类沿用现有规则 + LLM 与 `issue-overrides.yaml`。
2. **阶段 2：契约 → 计划**（组合）。
   - 契约命中模式 → **确定性编译**，不调 LLM。
   - 未命中 → 沿用现有路径：LLM 只在动作库（Node + 元素 + 生命周期动作）内组合，再经校验。
   - 校验扩展：前置条件在该端可建立（`unconstructible` → 暂缓并写明原因）；可观察后置条件在该端有可用通道（如 mobile-web 上的 `keyboard-shown` 不可用 → 校验失败）；`prepare-only` 的 Node 不得出现在 actions / afterCheck；构造类前置条件的目标会话必须在允许清单内（执行前核对，见 5.5）；原有规则（元素存在、间隔 ≤1 s、步数上限）不变。
   - 校验失败 → **保持现状**降级到通用模板（D3），并计算 `coverage`：通用模板只覆盖 `crash` / `page-error`，契约的可观察后置条件不是这两种时为 `not-covered`，报告结论旁注明「计划未覆盖 Issue 现象，仅说明无崩溃」。
   - 不让 LLM 反复重试到通过为止（每个子用例最多 1 次 LLM 组合）。

### 5.4 动作库补充
- 新 Node `teamily.quoteReply { target, text }`（`phase: 'prepare-only'`）：长按目标消息 → 用分层定位找「引用 / 回复」菜单项（准备期允许 ①→③）→ 输入文字 → 发送。
- 新 Node `teamily.sendMessage` 增加 `kind: 'plain' | 'markdown-link'` 参数（构造含 Markdown 链接语法的消息）。
- 新目标类型 `quote-preview`：会话底部最近的引用块（Android 读引用卡片的 desc，现有 `quoteCards`）。
- 所有 `phase: 'prepare-only'` 的 Node 可以调用定位服务；`phase: 'any'` 的 Node 只按坐标操作（现规则）。

### 5.5 构造允许清单与私有会话配置
- `platform/conversations.local.yaml`（被 `*.local.yaml` 忽略，不入库）：`construct.allow`：允许构造前置条件的会话标题；`sync.defaultConversation`：sync 默认会话（从 `sync.ts:107` 迁来）。
- 准备阶段选中的构造目标必须在 `construct.allow` 里，否则执行失败并说明「前置条件需构造，但没有允许的会话」。构造出的消息不撤回（池账号都是测试账号）。

### 5.6 确认单与证据复核
- CLI `confirmationSheet` 与控制台都展示：前置条件（及建立方式）、触发语义、可观察后置条件、推测机制（标「推测」）、命中的模式或「模型组合」、`coverage`。用户仍然只确认一次（勾选子用例 / 替代端），确认对象是整份草稿（哈希，§3.7）。
- 证据复核的对照文本改为契约的 `observable.phenomenon`；没有契约的计划（smoke / 临时计划）沿用 Issue 原文。

### 5.7 P2 验收
- 10 份 Issue：可执行与暂缓的 8 份都生成契约；拒绝的 2 份照旧出拒绝报告；暂缓类的契约写明哪条前置条件是 `unconstructible`。
- 回归一致：1594、1329 s1–s3、2336、2122 由契约 + 模式编译出的计划，与 `platform/plans/*.json` 里的现行计划除 `contract` / `coverage` / `provenance` 外逐字段一致（P1 改过判定的 1329 s1 / s3 以 P1 之后的版本为准）。
- **2044 端到端（生产环境）**：契约 = 前置条件「一条含 Markdown 链接的消息被引用回复」（`construct`）+ 触发「查看引用块预览」+ 观察 `text`（引用块不应出现 `](` 这类 Markdown 语法）。iOS → android-app 替代经一次性确认；prepare 在允许清单内的会话中发出含 Markdown 链接语法的消息并引用回复；prepareCheck 确认引用块存在；循环（重开会话 → 读引用块）中视觉调用 = 0；按必现规则（连续 3 次）给出结论，并附引用块文字与截图证据。无论复现与否，都要如实给出结论。
- 1329 s2 的 mobile-web 子用例不再落到通用浏览：命中引用跳转模式；该端只能视觉判定时报告写明。
- 构造前置条件只发生在允许清单内的会话（日志可查）。

---

## 6. P3：预热闸门 + 指纹

### 6.1 预热轮（闸门）
- 时机：准备阶段完成、进入循环之前；只适用于循环类计划（bug-always / bug-intermittent / suspected-misuse），feature 的逐项验收不需要。
- 做法：按计划跑一轮 actions，**每一步之后**核验预期效果——
  - 固定元素：沿用 `vocab.ts` 已有的 `selfCheck` 语义（`navigate` → 页面变化 / 目标页参考区域出现；`focus` → 键盘弹出或焦点变化；`popup` → 区域变化）；
  - Node：在 Node 表里声明效果（`openConversation` → `chat/composer` 出现；`switchConversation` → 回到原会话；`typeMention` 不核验——它就是要观察的对象）；
  - 生命周期动作：`exitApp` → 前台不是本 App；`killApp` → 进程不在；`launch` → 进程在。
  - 核验走 §4.1 的分层通道。预热轮的耗时不计入动作间隔统计。
- 记录每一步：动作、预期效果、实际结果、判定层、耗时，以及点击点的**元素指纹**（Android：点击前读一次界面树，取覆盖点击点的最小节点的 text / desc / class / bounds；Web：无障碍快照中覆盖点击点的 role / name）。写入运行目录 `warmup.json`。
- 判定：
  - 任何一步的效果未出现（允许 1 次重做该步）→ 结论 **「计划不可执行（预热第 k 步：<动作> 预期 <效果> 未出现）」**，不进入循环，不出「未复现」；把失败信息回写到草稿（`warmupFailures`），下次确认单上展示。
  - 预热轮中的硬异常（闪退 / ANR / 进程死亡）照常算命中；预热轮的检查点结果只记录（作为参考，如引用跳转的基线），不计入判定。
- 结论词表新增「计划不可执行」，报告、控制台、退出码（与「执行失败」同为 3）同步。

### 6.2 指纹固化与自愈（削减线：P3 中先砍这项）
- 标定时为每个固定元素记录文字指纹（Android：text / desc / class；Web：role / name / text），写入 profile 的 `elements[id].fingerprint`；冻结的动态目标记录标题 / 文字。
- SKILL 有效性检查失败、或预热某步在固定元素上失败时：先按指纹走 ① 层重新定位该页元素；全部找到 → 本次运行改用新坐标，报告「坐标自愈」一节（元素、旧坐标 → 新坐标、依据），并把候选 profile 写到运行目录（`healed-profile.json`），**不覆盖** `skills/teamily/profiles/`；找不到 → 照旧报「SKILL 失效」。
- 循环中不做自愈（循环不读界面树）；循环中的漂移仍按现有「操作偏离 → 重做 setup」处理。

### 6.3 P3 验收
- 现有可执行计划（1594、1329 s1–s3、2044）的预热轮全部通过，并生成 `warmup.json`。
- 故意制造一份不可执行的计划（如把 `chat.composer` 换成一个位置错误的元素，用临时 profile 副本，不改正式 profile）：预热在对应步失败，结论为「计划不可执行」，不进入循环，草稿上能看到回写的失败信息。
- 自愈（若未被削减）：临时 profile 副本中把 `nav.chat` 偏移 200 px → 有效性检查失败 → 按指纹找回 → 运行继续，报告出现「坐标自愈」，正式 profile 未被修改。

---

## 7. 轨迹记录（随 P2 / P3 落地）+ P4：TencentDB Agent Memory（可选）

### 7.1 轨迹格式 `trajectory-v1`（本期必做）
- 每次运行在运行目录写 `trajectory.jsonl`，一行一个事件：`contract`、`plan`（含草稿哈希）、`lease`、`prep.target`（候选、选择、理由、层）、`warmup.step`、`op`（坐标动作，复用现有 `CoordOp`）、`observe`（判定、层、耗时）、`locate`、`model-call`（用途、模型名、耗时、层；**不记录提示词中的凭据**，图片只记相对路径）、`hit`、`dismissed`、`incident`、`verdict`。
- 接口 `TrajectorySink { emit(event); close(summary) }`；默认实现 `JsonlSink`。sink 的任何异常都被吞掉并只记一次警告，**绝不影响测试运行**；队列有上限，超出时丢弃 `op` 事件并计数。
- 字段设计可无损映射到 TDAI `/v3/session/add`：`user_query` ← Issue id + 标题 + 子用例；`messages[]` ← 事件；`output` ← 结论摘要；`model` ← 计划 / 视觉模型名；`started_at` / `ended_at` ← 运行起止时间（`YYYY-MM-DDTHH:MM:SS.sssZ`）。

### 7.2 P4：TDAI `session/add` 适配（可选，默认关闭，削减线最先砍）
- 已核实的事实（`ref/TencentDB-Agent-Memory`）：
  - standalone = 单个 Node 网关进程，`127.0.0.1:8420`，SQLite + 本地文件；要求 Node ≥22.16（本机 22.23，`node:sqlite` 支持 FTS5，已实测）；MIT 许可，beta。
  - `POST /v3/session/add`：嵌套 JSON 原样写成一个文件，不经过 LLM，单次请求上限 32 MiB；不认识的顶层字段返回 422；身份只从请求头 `x-tdai-service-id` / `x-tdai-user-id` / `x-tdai-session-id` 来；不幂等，每次调用都新写一个文件。
  - 项目里**没有读回 `session/add` 记录的接口**；TS SDK 也没有封装它。可检索的 `conversation/add` 需要把轨迹压平成纯文本，而且会自动触发 LLM 提炼，找不到可靠的关闭开关——**本期不用**。
- 实现：`TdaiSessionSink`，`close()` 时发一次请求；请求头 `x-tdai-service-id: multi-test-agent`、`x-tdai-user-id: <账号池 id，如 prod-aaron1>`、`x-tdai-session-id: <运行 id>`；超时 3 s，不重试（避免超时后重试写出重复文件）。由 `TRAJECTORY_TDAI_URL` 开启。
- 网关运行：`ref/` 只读——把 MemoryCore 复制到 `tools/tdai/`（已在 gitignore）里安装并运行；**网关不配置 LLM key**（我们不调用 `conversation/add`，也不让任何数据流向 LLM）；Windows 安装若失败，记录原因并降级为只用 JSONL，不卡在安装上。
- P4 验收：一次真实 Issue 运行后，网关数据目录 `sessions/offline/...` 下出现对应文件，内容与 `trajectory.jsonl` 一致；网关未启动时，同一次运行的结论与耗时不受影响（单测 + 实跑各一次）。

---

## 8. 子任务拆分（goal mode 执行顺序）

| # | 子任务 | 依赖 | 完成判据 |
|---|---|---|---|
| T0 | 分支 `feat/w2m1-contract-tiered-observe`；记录回归门基线（§3.9 全套）到 `docs/w2m1-acceptance.md` | — | 基线数字入文档 |
| T1 | P0 3.1 `core/ui-tree` + 3.2 `core/model`（替换全部调用点） | T0 | 回归门通过；grep 不再出现散落的 `uiautomator dump` / 自建 Midscene agent |
| T2 | P0 3.3 `SurfaceSession` + 端适配器；run / sync / replay / smoke 迁移 | T1 | 回归门通过；`run.ts` / `sync.ts` 中不再有 `surface === 'android-web'` 分支 |
| T3 | P0 3.4 拆分 `runPlan` + 3.5 单一来源 / 去循环 + 3.8 小修与死代码 | T2 | 回归门通过；`runPlan` ≤150 行；包级循环消除 |
| T4 | P0 3.6 模式库迁移（golden）+ 3.7 确认即冻结 | T3 | golden 全等；控制台 / CLI 确认哈希 = 执行计划哈希 |
| T5 | P0 回归门全套 + 3.9 新单测 | T4 | §3.9 全部通过，结论与统计口径和 M5 / M6 一致 |
| T6 | P1 观察库 + `keyboard` / `text` 检查 + 判定分层统计 | T5 | 单测覆盖通道链选择；报告出现分层统计 |
| T7 | P1 分层定位服务，接入准备期 / 弹窗 / android-web 标定 / sync；`Ranker` 插槽 | T6 | 准备期日志显示每个目标的定位层 |
| T8 | P1 真机：核实点赞的无障碍可读性；1329 s3 / s1 15 分钟；sync 三端 3 轮 | T7 | §4.4 |
| T9 | P2 契约 schema + 三个库 + 阶段 1 生成 + 确认单展示 | T5 | 10 份 Issue 出契约 / 拒绝报告 |
| T10 | P2 阶段 2 编译 + 校验扩展 + `coverage` 标注 + 证据复核接契约 + 允许清单 + 新 Node | T9 | 回归编译一致；2044 编译出 `quote-preview-text` 计划 |
| T11 | P2 2044 生产端到端；1329 s2 mobile-web 改走模式 | T10、T8 | §5.7 |
| T12 | 轨迹格式 + `TrajectorySink` + `JsonlSink`（随 T9–T11 产生事件） | T9 | 每次运行都有 `trajectory.jsonl`；sink 抛错不影响运行（单测） |
| T13 | P3 预热闸门 + 指纹记录 + 「计划不可执行」结论 + 回写草稿 | T11 | §6.3 前两条 |
| T14 | P3 指纹自愈（削减线第二） | T13 | §6.3 第三条 |
| T15 | P4 TDAI `session/add` 适配（削减线第一） | T12 | §7.2 验收 |
| T16 | 文档：README、CHANGELOG、`skills/teamily/*.md`（模式库 / 观察库 / 前置条件库 / 操作规范更新）、`docs/w2m1-acceptance.md` | 全部 | 文档与代码一致 |

---

## 9. 验收标准

1. **基座**：P0 后 `runPlan` ≤150 行；读界面树、模型调用、Midscene agent、执行会话各只有一处实现；Node / Surface / profile 命名 / 包名 / `issuePath` 单一来源；包级循环消除；新增单测覆盖 ui-tree、actions、checkpoint、端适配器、模式库 golden、确认哈希。
2. **行为不变**：§3.9 回归门全部通过，1594、1329 s2、sync、smoke、lifecycle、证据复核预置用例的结论与 M5 / M6 一致。
3. **确认即冻结**：执行计划的哈希等于确认时的草稿哈希；`run --issue` 不加 `--redraft` 时不调用计划模型。
4. **分层判定**：1329 s3 跑满 15 分钟，循环与检查点的视觉调用 = 0，轮速 ≥14 轮/分钟，最大动作间隔 ≤1 s；报告含判定分层统计。
5. **分层定位**：准备期 / 弹窗 / android-web 标定 / sync 都经定位服务，日志与轨迹里能看到每次定位用的是哪一层；循环中 0 次定位、0 次读界面树。
6. **契约**：8 份可执行 / 暂缓的 Issue 都有契约；确认单展示契约；证据复核按契约的 `phenomenon` 对照；未覆盖的计划报告带标注。
7. **2044**：在生产环境由 android-app 替代执行（一次性确认），前置条件在允许清单内的会话中构造，循环中 0 视觉，结论附引用块文字证据。
8. **预热闸门**：可执行计划的预热轮通过；人为制造的不可执行计划得到「计划不可执行」，不进入循环。
9. **轨迹**：每次运行都有 `trajectory.jsonl`，不含凭据；sink 失败不影响运行。P4（若未被削减）：TDAI 网关收到同一份轨迹。
10. **现有入口**：mission / explore / monkey / imui / test:web / test:android / week-1 脚本照常可用；`pnpm typecheck`、`pnpm test:unit` 通过。

---

## 10. 硬约束与自主工作规则

- 黑盒边界按 §2.1：不 `evaluate`、不注入、不连调试端口；只读观察只用于准备期、预热轮、检查点、证据复核与标定。
- **循环每一步：只按坐标操作，不读界面树、不读 DOM、不调视觉、不定位**；动作间隔 ≤1 s；一份 Issue 只启动一次 App（启动类问题除外）。
- P0 行为不变：先存 golden / 基线，再重构；行为确需改变的（如确认即冻结）在 CHANGELOG「Changed / Fixed」写明原因。
- 不新增重型依赖到主项目（本期不引入 onnxruntime 等）；TDAI 网关的依赖只安装在 `tools/tdai/`，不进主项目的 `package.json`。`ref/` 只读。
- 生产环境构造数据只在允许清单内的会话；凭据只在本地私有文件，不进日志、报告、轨迹、提交。
- 不 mock 判定、定位、崩溃或回放产物；无法验证的路径标「未验证」并写明原因；工具装不上就降级，不卡在安装上。
- 每个子任务：单测 + typecheck + 回归门（或其中相关部分）+ 真机 / 浏览器验证，通过后再提交；提交信息 `refactor(scope): …` / `feat(scope): …` / `fix(scope): …`；CHANGELOG 增加「[Unreleased] — W2-1」一节；验收证据写入 `docs/w2m1-acceptance.md`。

---

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 大重构引入隐性行为变化 | 先存 golden 与回归基线；按 T1–T4 小步提交，每步都跑回归门 |
| 读界面树慢（2.6–3.7 s），在 UI 动画或 AI 流式回复时还会失败 | 只在循环外读；失败重试并计数；连续失败就退到 ③ 并在报告中注明 |
| 点赞等状态在无障碍树中不可读 | P1 先核实；不可读则保持视觉判定，并如实报告 |
| android-web 的无障碍树在页面内跳转后不更新 | 该端的 `text` / `locate` 默认允许回退到 ③；统计中单列 |
| 契约由 LLM 填写时选错模式 | 模式有前置条件 / 观察 / 适用端的硬约束，校验能挡住大部分；确认单展示契约，由人一次性把关 |
| 降级保持现状，仍可能产出语义不符的计划 | `coverage` 标注在报告首行可见，结论不会被误读为「已修复」 |
| 构造前置条件在生产群里留下消息 | 只在允许清单内的会话；池账号均为测试账号（不撤回） |
| 预热轮逐步核验让准备时间变长 | 只跑一轮；耗时单独统计，不计入动作间隔 |
| TDAI 为 beta、依赖重、Windows 下未经验证 | P4 可选且默认关闭；装不上就只用 JSONL；网关不配置 LLM key |

---

## 12. 本期不做

- 循环中逐步读界面树 / DOM（D1）；第②层本地嵌入模型（D2，只留插槽）；手机端常驻无障碍服务（uiautomator2 server 类，需要装辅助 APK）。
- mission 入口迁到契约流水线；iOS 执行端；多角色 Issue 计划（1919、2235、2122 的第二账号部分）。
- TDAI `conversation/add` 可检索记忆、L1–L3 提炼、规划器查询历史轨迹（等 `session/add` 的读回能力或另行评估）。
- 删除 week-1 脚本（D8）。

---

## 13. 澄清记录

- 2026-10-26 第一轮：D1 循环外分层；D2 第②层只留接口；D3 降级保持现状；D4 Web 只读观察放在准备 / 预热 / 检查点。
- 2026-10-26 第二轮：D5 生产构造只在池账号会话；D6 系统状态读取允许；D7 P0–P3 全做；D8 删无入口死代码。
- 2026-10-26 追加需求：接入 `ref/TencentDB-Agent-Memory`（standalone）记录原始轨迹 → 评估后定为 D9（本期定格式与接口，TDAI 适配为 P4 可选）。
- 2026-10-26 用户确认目标汇总，生成本文档。无剩余开放项。

---

## 实现对照（2026-10-29 按代码核对）

> 本节是事后核对，以上正文保留当时的需求原文。项目当前全貌见 `PROJECT-SUMMARY.md`；验收证据见 `docs/w2m1-acceptance.md`。

**已实现**（分支 `feat/w2m1-contract-tiered-observe`，2026-10-28 经 `3704bbd` 合并到 `main`）

- **P0 基座**
  - 界面树读取统一到 `core/ui-tree.ts#readUiXml` / `#dumpTree`（按设备串行、4 个轮换文件、UI 不空闲时重试、计时），`parseNodes` 从 imui 移入。
  - 模型调用统一到 `core/model/llm.ts`（`#chatJson`、`#visionJson`、按用途计数的 `#countCall`、`#majority`、`#extractJson`）和 `core/model/midscene.ts`（按设备 / 页面缓存 agent 的 `#visionAsk`、`#visionLocateRect`）。
  - 执行会话 `executor/session.ts#openSession` / `#enterApp`，端适配器放在**单个文件** `executor/surfaces.ts`（正文为 `surfaces/` 目录）。`run.ts`、`sync.ts` 里不再有 android-web 分支。
  - `runPlan` 拆出 `prepare.ts`、`phases.ts`、`loop.ts`、`checkpoint.ts`、`incident-hook.ts`、`stats.ts`、`actions.ts`。
  - 单一来源：Node 表 `skills/teamily/node-specs.ts`；Surface 类型 `platform/schema/test-plan.ts#SURFACES`；包名 `drivers/factory.ts#TEAMILY_PACKAGE`；`issue/paths.ts#issuePath`。
  - 登录流程移到 `executor/login/`，坐标重放移到 `executor/replay.ts`，Issue CLI 移到 `scripts/issue-cli.ts`，标定公共部分抽到 `skills/calibrate-common.ts`。
  - 模式库是**单个文件** `skills/teamily/patterns.ts`（正文为 `patterns/` 目录），golden 在 `issue/__golden__/templates.json`，`issue/golden.spec.ts` 守护。
  - 确认即冻结：`issue/drafts.ts#draftHash` / `#loadSavedDraft`；`scripts/issue-cli.ts#runIssue` 把计划写入 `platform/plans/` 再读回，并核对 `draftHash`。
  - 私有会话配置 `platform/conversations.ts#loadConversations`（`platform/conversations.local.yaml`）。
- **P1 观察与定位**
  - 观察库 `executor/observe.ts#OBSERVATIONS`（8 种观察）、`#observeKeyboard`（`dumpsys input_method`）、`#observeText`（Android 无障碍 / Web 页面文字 → 视觉兜底）；② 层插槽 `#noRanker` 是空实现。
  - CheckPoint 新增 `keyboard`、`text`（`match`、`scope`）。报告「判定分层统计」由 `issue/report.ts#runMarkdown` 渲染，数据来自 `stats.observeTiers` / `locateTiers` / `modelCallsByPurpose`。
  - 分层定位 `executor/locate.ts#locate` / `#locateText`，用于准备期目标、下载 App 弹窗（`executor/surfaces.ts` 内的 `waitPastDialog`）、prepare-only 的 Node、android-web 标定。
  - 1329 s3 的键盘检查、1329 s1 在 App 上的点赞检查改为 ① 判定（`patterns.ts` 的 `keyboard-single-tap`、`like-visible`）；多端同步的 Web 接收端改读页面文字（`executor/sync.ts#lineVisible`）。
- **P2 契约**
  - 契约 schema 在 `platform/schema/contract.ts`；前置条件库在 `skills/teamily/preconditions.ts`。
  - 契约生成 `issue/contract.ts#contractFor`：命中模式时用规则契约，否则交给模型（`#modelContract`，只能用库里的 id），模型失败退回规则契约。
  - 编译与校验：`issue/planner.ts#draftIssue`（每个子用例最多调一次模型组合）+ `issue/validate.ts#validatePlan`（观察在该端是否可用、需构造的前置条件必须有 prepare 步骤、prepare-only 的 Node 不进循环）；`contract.ts#coverageOf` 标注覆盖情况；前置条件都不可构造时转为暂缓。
  - 新模式 `quote-preview-text`；新 Node `teamily.quoteReply`（prepare-only）；`sendMessage` 增加 `kind: markdown-link`。
  - 允许清单在 `executor/prepare.ts#assertConstructionAllowed` 中核对。
  - 证据复核对照契约的 `phenomenon`：`executor/run.ts#runPlan` 用它替换 Issue 的「实际结果」。
- **P3 预热与指纹**
  - 预热 `executor/warmup.ts#runWarmup`：`#expectedEffect` 决定每步预期效果，每步允许重做 1 次；失败抛 `WarmupError`，结论为「计划不可执行」，写 `warmup.json`；旧入口退出码为 3。
  - 指纹自愈 `executor/heal.ts`：结果只写运行目录的 `healed-profile.json`，不改标定文件。
- **轨迹**
  - `core/trajectory.ts#Trajectory`：每次运行写 `trajectory.jsonl`；队列有上限，超出时先丢 `op` 事件并计数；`#scrub` 过滤凭据样式的字段。
  - `#TdaiSessionSink`：设置 `TRAJECTORY_TDAI_URL` 时，结束时发一次 `/v3/session/add`，超时 3 秒，不重试。

**与正文不同 / 后来的变化**

- **`runPlan` 又变长了**：W2-1 合并时 135 行，达到「≤ 150 行」；W2-2 合并后 222 行，现在 241 行（`executor/run.ts`）。CHANGELOG 写的「458 → 96 行」是拆分当时的数字。
- **两处「唯一来源」没有守住**：
  - `mission/planner.ts#planMission` 仍自带一份模型请求，绕过了 `countCall` 计数；
  - `imui/clients/android.ts` 仍有私有的键盘判断与读树重试（底层已改用 `core/ui-tree`）。
- **§3.8 要删的 `executor/checks.ts#MATCH_DISTANCE` 还在**，没有被使用。
- ~~预热失败回写草稿只在旧入口~~ **已修复（2026-10-30）**：W2-3 主路径 `scripts/task-exec.ts#execTask` 也经 `issue/drafts.ts#recordWarmupFailures` 写回同版本的已保存草稿。
- **Web 端预热不记指纹**：`warmup.ts` 只在 Android 上读界面树取点击点的元素指纹，Web 端不记录（正文要求记 role / name）。
- **自愈门槛比正文宽**：`executor/session.ts#enterApp` 只要有一个首页元素按指纹找回就继续运行（正文要求全部找到），首页参考区域本身也不更新。android-web 中由视觉定位的元素没有指纹。
- **预置用例的对照文本不同**：证据复核预置用例（`incident/evidence-cases.ts`）对照的仍是 Issue 原文的「实际结果」，与实际运行对照契约现象不一致。
