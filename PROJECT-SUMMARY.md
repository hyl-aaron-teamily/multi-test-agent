# multi-test-agent 项目总结

> 截至 2026-10-20，`main` 分支（合并提交 `87c01e3`）。详细用法见 `README.md`，变更与真机记录见 `CHANGELOG.md`。

## 1. 进度概览

| 阶段 | 内容 | 状态 |
|---|---|---|
| W1 Web 基线 | Midscene `PlaywrightAgent` + Vitest + Allure，saucedemo 5 步登录用例 | ✅ 已合并，`pnpm test:web` 1/1 |
| W2 Android ADB | 设备发现、`AndroidAgent`、系统设置 5 步原生流程、logcat 崩溃监控、高频循环 | ✅ 已合并，`pnpm test:android` 5/5 |
| W3 通用探索 + Monkey | 路径 A AI 探索、路径 B Monkey 压测、统一问题报告 | ✅ 已合并（本地，未推送），单测 7/7 |

W3 真机结果（Xiaomi 2211133C / Android 16）：

- **Teamily AI（生产环境）**：AI 探索跑了 6 轮，每轮 10–30 步，覆盖 4–9 个页面状态，没有捕获到崩溃或 ANR。覆盖范围：个人资料、设置、编辑资料（只读）、收藏、点赞、智能体列表、智能体团队、Agent 设置、技能库、群信息、排行榜、聊天记录。没有点支付和发送消息。
- **Monkey（系统计算器）**：seed 12345 跑 3000 个事件，没有崩溃。另外用 `am crash` 注入一次崩溃做自检，logcat 捕获到并和 monkey.log 对上了。
- **生产副作用**：前期探索改动过 3 处数据（免打扰开关、翻译语言、输入框模板草稿），都已手动还原，草稿没有发出去。之后把这几类控件加进了禁点名单。

代码规模：TypeScript 约 2300 行，共 24 个文件（含测试）。

## 2. 部署

### 2.1 环境要求

- Node.js ≥ 20（开发机为 v22），pnpm
- Web：Chromium（`pnpm exec playwright install chromium`）
- Android：Android platform-tools（adb），手机开启 USB 调试并授权
- 报告：Java（Allure 生成用）
- AI 路径（W1 Web、W2 AI 流程、W3 路径 A）需要视觉模型接口；Monkey 和 `FLOW=launch` 不需要

### 2.2 安装步骤

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env          # 填入模型配置
adb devices -l                # 设备状态应为 "device"
```

`.env` 关键变量：

| 变量 | 说明 |
|---|---|
| `MIDSCENE_MODEL_BASE_URL` / `MIDSCENE_MODEL_API_KEY` / `MIDSCENE_MODEL_NAME` / `MIDSCENE_MODEL_FAMILY` | 视觉模型配置；缺失时 AI 用例会报 `[waiting for credentials]` |
| `MIDSCENE_ADB_PATH` | 可选，adb 不在 PATH 时填完整路径（也会自动查找 `./tools/platform-tools/adb`） |
| `DEVICE_ID` | 可选，多台设备时指定 |

### 2.3 自检

```bash
pnpm typecheck && pnpm test:unit      # 无需设备和模型
pnpm crash-check:android              # 需设备，无需模型：验证 logcat 崩溃捕获
pnpm test:web && pnpm test:android    # 完整基线
```

## 3. 使用

| 场景 | 命令 |
|---|---|
| Web 用例 | `pnpm test:web` → `pnpm report` → `pnpm exec allure open ./allure-report` |
| Android 原生流程 | `pnpm test:android` |
| 高频稳定性循环 | `pnpm loop:android --count 50`（`APP_PACKAGE`、`FAIL_FAST`、`FLOW=launch`） |
| AI 探索指定 App | `pnpm explore --package <pkg> --steps 30 --focus "个人资料, agent"` |
| 从指定入口开始探索 | `EXPLORE_ENTRY="the user avatar at the top-left corner" pnpm explore --package <pkg>` |
| Monkey 压测 | `pnpm monkey --package <pkg> --seed 12345 --events 3000`（`MONKEY_ROUNDS`、`MONKEY_NATIVE_CRASHES=false`） |
| 汇总问题报告 | `pnpm report:problems` → `midscene_run/problem-report.md` |

产物位置：

| 产物 | 路径 |
|---|---|
| 崩溃现场（截图 + logcat + context.json） | `midscene_run/crashes/<ts>/`，`context.json` 的 `source` 为 `ai-explore` 或 `monkey` |
| 探索轨迹 | `midscene_run/explore-traces/<ts>.json` |
| Midscene 每步回放 | `midscene_run/report/*.html` |
| Monkey 日志与汇总 | `monkey_run/<ts>-r<n>-s<seed>/monkey.log`、`monkey_run/summary.json` |
| Allure | `allure-results/` → `allure-report/` |

安全注意：
- **AI 探索**：默认只读。输入框、开关，以及支付、发送、保存、删除、编辑、置顶、更改、模板等标签都不会被点击。但这只是按关键词判断，不能保证一定拦住，在生产账号上跑完仍需人工核对。
- **Monkey**：随机点击无法约束，不要对生产账号的 IM 或支付类 App 运行。

## 4. 系统架构

```
                ┌───────────────────── CLI / Vitest 入口 ─────────────────────┐
                │ tests/web  tests/android  scripts/loop-android  scripts/explore │
                │ scripts/monkey  scripts/crash-check-android  report/problem-report │
                └──────────────┬──────────────────────┬───────────────────────┘
                               │                      │
          ┌────────────────────▼───────┐   ┌──────────▼─────────────┐
          │ 路径 A  explore/            │   │ 路径 B  monkey/         │
          │ page-observer (aiQuery)     │   │ runner  (adb monkey)    │
          │ state-tracker (指纹/已探索) │   │ log-parser (CRASH/ANR)  │
          │ explore-loop (有界+安全过滤)│   │ loop    (多轮/seed)     │
          │ trace (轨迹 JSON)           │   │  —— 不依赖 Midscene ——  │
          └──────┬──────────────────────┘   └──────────┬─────────────┘
                 │                                     │
     ┌───────────▼──────────┐          ┌───────────────▼───────────────┐
     │ fixtures/             │          │ core/                          │
     │ page.ts  (Playwright) │─────────▶│ adb.ts  (child_process 封装)    │
     │ android.ts (Agent)    │          │ logcat-monitor.ts (崩溃现场)    │
     └───────────┬──────────┘          │ credentials.ts                 │
                 │                      └───────────────┬───────────────┘
     ┌───────────▼──────────┐                           │
     │ @midscene/web|android │── 视觉模型 API     adb ──▶ 真机 / 浏览器
     └──────────────────────┘
                 产物 ──▶ midscene_run/ · monkey_run/ · allure-results/
                      └──▶ report/problem-report.ts 汇总为 Markdown
```

设计要点：

1. **分层**：`core/` 只依赖 Node 和 adb，可在无模型时使用；`fixtures/` 负责创建 Agent，并检查凭据和设备；上层用例与脚本只做编排。
2. **两条路径互不依赖**：`explore/` 不引用 Monkey，`monkey/` 不引用 Midscene，二者只通过 `core/` 共享 adb 工具和 logcat 监控，产物结构统一（`context.json.source`）。
3. **崩溃判定以 logcat 为准**：`FATAL EXCEPTION` / `ANR in` / crash buffer 为主信号；Monkey 日志在 ±15s 时间窗内交叉验证；`am crash` 注入的崩溃在报告里标为非缺陷。
4. **探索以「界面状态」为单位**：状态 ID 优先用 AI 提取的页面标题加当前 activity 生成，退化时用截图 md5 加元素类型分布；每个状态有操作预算，用完按 Back 离开；跳转与否按前后 stateId 是否变化判断。
5. **可复现**：Monkey 每轮记录 seed 和可复制执行的复现命令；探索轨迹记录每一步的状态、元素、动作和结果，崩溃目录里附带当时的轨迹。
6. **轻依赖**：adb 用 `child_process` 调用，哈希用 `node:crypto`，没有引入 adb 或图像处理类 npm 包。

## 5. 与参考代码的相似度

### 5.1 字面重复度（量化）

方法：将本项目全部 `.ts` 与 `ref/midscene-example/**/*.{ts,js}` 做逐行比对。每行先去掉首尾空白并压缩空格，再排除 import、注释和 ≤12 字符的短行，统计本项目中与 ref 完全相同的行所占比例。

| 范围 | 有效行 | 与 ref 相同 | 比例 |
|---|---|---|---|
| **全项目** | 1392 | 29 | **2.1%** |
| `core/`、`explore/`、`monkey/`、`report/`（W2 监控 + W3 全部） | 约 700 | 3 | <0.5% |
| `fixtures/page.ts` | 57 | 5 | 8.8%（类型签名，如 `viewport?: {...}`） |
| `scripts/crash-check-android.ts` | 25 | 4 | 16.0%（`sleep`、`async function main()`、`process.exit(1)` 等样板） |
| `vitest.config.ts` | 15 | 2 | 13.3%（`defineConfig`、超时配置） |

重复行基本都是通用样板，没有成段照搬的业务逻辑。

### 5.2 结构/思路上的借鉴（定性）

| ref 来源 | 借鉴内容 | 相似程度 |
|---|---|---|
| `playwright-with-vitest-demo/` | Vitest + Midscene 的 fixture 组织、dotenv 与超时配置、`.env` 变量名 | 结构相近，代码自写 |
| `android/vitest-demo/tests/*.test.ts` | `getConnectedDevices → new AndroidDevice → new AndroidAgent → connect` 调用顺序 | API 用法一致（SDK 规定的唯一用法） |
| `android/javascript-sdk-demo/demo.ts` | `aiQuery` 形状字符串、`autoDismissKeyboard: false`、纯脚本形态 | API 用法一致 |
| `playwright-mind/` | 「AI 操作 → aiQuery → expect → aiAssert」分工 | 仅思路 |
| `midscene-skills/android-automation` | 未下载，未参考 | — |
| logcat 监控、Monkey 解析、状态指纹、安全过滤、问题报告 | ref 中无对应实现 | 原创 |

## 6. 已知限制

- AI 探索的禁点判断依赖关键词，可能漏判或误判。例如 `skill-creator` 因含 create 被跳过。
- `EXPLORE_ENTRY` 对没有文字的图标定位不稳定（一次成功、一次点偏）。
- 状态指纹依赖 AI 提取的标题，标题相同但内容不同的页面会被并成一个状态（如技能库与技能详情弹层）。
- 默认带的 `--monitor-native-crashes` 在旧崩溃转储文件多的设备上会让 Monkey 在启动阶段停滞数分钟（可用 `MONKEY_NATIVE_CRASHES=false` 关掉）。
- W3 分支已在本地合并到 `main`，**尚未推送**远端。

## 7. 下一步建议

1. 执行前用 `aiBoolean` 判断这个操作是否会修改数据、发送消息或付费，与关键词名单配合，作为第二道防线。
2. 探索策略加入覆盖度反馈：优先去访问次数少的状态，必要时回到入口重走。
3. 接入 WebView/Hybrid 的 CDP 通道（Teamily 的技能库、成果页）。
4. 生成 HTML 看板：状态转换图、崩溃时间线。
5. 准备 Teamily 测试环境或测试账号后，再对 IM 场景跑 Monkey。
