# 任务：搭建 Web 端 AI 驱动的自动化测试脚手架（第一周里程碑）

## 项目背景

我正在构建一个「Web + Android ADB 智能自动化测试平台」，最终目标是覆盖桌面 Web、Android 原生、Hybrid WebView、微信小程序 H5，并用 AI 视觉 Agent 替代脆弱的 CSS 选择器。长期还要支持高频循环复现偶发闪退、logcat 崩溃捕获、Monkey 随机压测、CLI + 轻量 Web 控制台。

**但本次任务只做第一周里程碑：Web 端跑通 Midscene + Vitest + Allure 的最小闭环。** 不要提前实现 Android、WebView、小程序、Monkey、控制台等任何后续能力。

## 本地参考工程（最高优先级信息源）

项目根目录下已有 `ref/` 目录，内含我已提前下载的开源参考工程。**这是你在本任务中最权威的信息源，优先级高于你的训练记忆和在线文档。** 开工前必须先侦察，开发中必须先查再写。

预期包含（目录名可能略有差异，以实际为准）：

| 参考工程 | 预期目录 | 核心用途 | 重点查看 |
|---|---|---|---|
| **Midscene 官方示例** | `ref/midscene-example/` 或类似 | **首选权威源** | `playwright-demo/`（Playwright 集成、`aiAction`/`aiQuery`/`cache`/`report` 用法）、`puppeteer-with-vitest-demo/`（Vitest 集成形态与 reporter 配置） |
| **社区完整 DEMO**（Playwright + Midscene + Vitest + Allure + TS） | 可能在 `ref/` 下以 `ai-*` 或 `testing-*` 命名 | 与你技术栈完全一致的**整体工程参考** | `.env.example` 的模型端点配置、Allure 与 Vitest 的配合方式、用例组织与报告生成脚本 |
| **playwright-mind** | `ref/playwright-mind/` 或类似 | `ai` / `aiQuery` / `aiAssert` 的**极简用法示例** | 测试文件中三个 API 的分工与写法 |
| **Allure Vitest 示例** | `ref/vitest-pnpm-ts/` 或类似 | **仅解决 Allure 接入** | `vitest.config.ts` 的 reporter 配置、`package.json` 的 `allure generate` 脚本 |

**强制工作流**：

1. **开工第一步（侦察）**：`ls -R ref/` 列出全部参考工程，对照上表识别每个目录的真实角色。若某个预期工程缺失，在最终汇报中记录，并降级到剩余参考工程 + 在线文档。
2. **每个模块动手前（先抄）**：在 `ref/` 中找到对应实现，**通读后再动手**。实现时在代码注释里标注来源，例如 `// ref: midscene-example/playwright-demo/tests/xxx.spec.ts`。不允许凭记忆直接写 Midscene API。
3. **遇到 API 不确定（查证顺序）**：`ref/` 中的实际用法 → `node_modules/@midscene/web` 的 `.d.ts` 类型定义 → 官方在线文档。三者冲突时以 `ref/` 可运行的代码和类型定义为准。
4. **最终汇报中必须包含「参考工程使用清单」**：列出每个 ref 工程被用在了哪里，哪些没有用上及原因。

## 硬约束（不可偏离）

- 语言：**TypeScript**，Node.js ≥ 18，包管理器用 **pnpm**（若环境无 pnpm 则用 npm，在 README 注明）。
- 核心依赖只用：`@midscene/web`、`vitest`、`allure-vitest`、`allure-commandline`、`playwright`、`dotenv`。
- **禁止**引入 Python、Appium、Selenium、uiautomator2、Puppeteer（`ref/` 中的 Puppeteer 示例仅作阅读参考，不引入依赖）、自研视觉模型。
- **禁止**搭建 Web 控制台、CI 配置、Docker、数据库。第一周全部 out of scope。
- **禁止**发明 Midscene 不存在的 API。任何 API 调用必须能在 `ref/` 或 `.d.ts` 中找到依据。
- **禁止**直接拷贝 `ref/` 中的整个工程进来。`ref/` 只读，作为参考；你的产出是独立的新工程。

## 第一周验收目标（Definition of Done）

在仓库根目录执行以下命令全部成功，且产物可人工检查：

1. `pnpm install` 无错误。
2. `pnpm exec playwright install chromium` 成功。
3. `pnpm test` 跑通全部用例，退出码 0。
4. `pnpm report` 生成 `./allure-report`，用 `pnpm exec allure open ./allure-report` 能打开，**每个步骤都有截图**，失败的断言能定位到具体步骤。
5. `README.md` 包含：项目简介、环境变量清单、安装/运行/报告命令、目录结构说明、后续扩展路线一句话、**参考工程使用清单**。

若模型 API 凭据缺失导致 `pnpm test` 无法真正跑通 AI 步骤，则验收标准 3、4 降级为：**用例能被 Vitest 发现并执行到「等待凭据」的明确报错**，README 中列出所需环境变量，并在最终汇报中标注为阻塞项。其余标准不变。

## 验证载体（避免依赖私有系统）

用公开 demo 站点 **https://www.saucedemo.com** 作为被测对象，实现一条 5 步流程：

1. 打开首页，断言出现登录表单。
2. 输入用户名 `standard_user`、密码 `secret_sauce`（用 `aiInput` 或 Playwright 原生 fill 均可，优先演示 AI 定位）。
3. 点击 Login。
4. `aiWaitFor` 等待进入商品列表页。
5. `aiAssert` 断言页面出现 "Products" 标题且商品数量 ≥ 6。

这条流程要能体现 **AI 定位 + 结构化断言 + 失败可诊断** 三个价值点。

## 目录结构（按此落地，不要另起炉灶）

```
.
├── .env.example
├── README.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── playwright.config.ts        # 如需
├── midscene.config.ts          # 如 Midscene 支持集中配置；否则用 .env
├── tests/
│   └── web/
│       └── saucedemo.login.spec.ts
├── fixtures/
│   └── page.ts                 # 封装 Playwright page + Midscene Agent
├── scripts/
│   └── report.ts               # 调用 allure generate
└── ref/                        # 只读参考工程，禁止修改
```

## 技术路线（按顺序执行，每步先查 `ref/` 再写）

**Step 0 — 侦察 `ref/`**
`ls -R ref/` 全部列出，对照「本地参考工程」表格为每个目录打标签，输出一份简短的「参考工程清单与角色映射」到你的工作记录。这一步完成后再进入 Step 1。

**Step 1 — 工程初始化**
`pnpm init`，装依赖，配 `tsconfig.json`（`strict: true`，`module: ESNext`，`target: ES2022`）。`vitest.config.ts` 的 reporter 配置**优先参考 `ref/` 中的 Allure Vitest 示例和社区 DEMO**，不要凭记忆写。`package.json` 加 `test` / `report` 脚本。

**Step 2 — Midscene 接入，优先官方 Vitest 集成**
先在 `ref/midscene-example/` 中确认 `@midscene/web` 是否导出 Vitest 集成（如 `createMidsceneWebTest` 或类似），若有，**照抄 `puppeteer-with-vitest-demo/` 的组织方式并替换驱动为 Playwright**。
**兜底路径**：若 Vitest 集成不可用或文档缺失，改用 `@midscene/web/playwright` 的 `PlaywrightAgent`，写法参考 `ref/midscene-example/playwright-demo/` 与 `ref/playwright-mind/`。Allure 步骤用 `allure-vitest` 的 `step()` 手动包裹，截图用 `allure.attachment()` 挂载。**兜底路径必须能跑通，不要卡在集成方式上。**

**Step 3 — 凭据与配置**
`.env.example` 的变量名与模型端点配置**优先抄 `ref/` 中社区 DEMO 的 `.env.example`**，与 Midscene 实际读取的变量对齐。代码中缺失凭据时抛出可读错误，提示用户复制 `.env.example` 为 `.env` 并填入。**不要伪造 key，不要跳过 AI 步骤假装成功。**

**Step 4 — 实现 saucedemo 五步流程**
用 `aiQuery` 获取结构化数据（如商品数量），用 `aiBoolean` 或 `aiAssert` 做断言，用 `aiTap`/`aiInput` 做交互。**具体写法优先抄 `ref/playwright-mind/` 的三 API 分工示例**。每一步用 Allure `step` 包裹并附截图。关键断言同时加一条 Playwright 原生断言作为确定性锚点（例如 `expect(await page.locator('.inventory_item').count()).toBeGreaterThanOrEqual(6)`），体现「AI 覆盖长尾 + 原生锚点保确定性」的设计意图。

**Step 5 — 报告与 README**
`scripts/report.ts` 调用 allure generate，脚本写法参考 `ref/` 中的 Allure 示例。README 写全第 5 条验收内容，并附「参考工程使用清单」。README 中额外用一句话说明「第一周只覆盖 Web，Android/WebView/闪退复现为后续里程碑」，防止后续误读。

## 自主工作规则

- **不要中途询问**。遇到 API 不确定，按「本地参考工程 → 类型定义 → 在线文档」的顺序查证，选最稳妥路径继续。
- **每完成一个模块，回写一句「来源」**：在汇报草稿里记录该模块参考了 `ref/` 的哪个文件。最终汇报直接汇总。
- 遇到非凭据类错误（依赖冲突、配置错误），自行修复并重试，最多 3 轮；仍失败则在最终汇报中列出错误全文和建议。
- **唯一允许的阻塞**：模型 API 凭据缺失且无法从环境推断。此时完成骨架 + README + 用例可达「等待凭据」状态，然后停止。
- 不要为了「看起来完成」而 mock 掉 AI 断言或删除断言。宁可失败，不可造假。
- **不要修改 `ref/` 下的任何文件**。需要试验的改动全部放在你自己的工程目录。

## 完成后的汇报格式

1. 验收命令逐条执行结果（成功/失败 + 关键输出）。
2. 最终目录树。
3. 使用的 Midscene 集成方式（官方 Vitest 集成 / PlaywrightAgent 兜底），并注明参考了 `ref/` 中哪个文件。
4. **参考工程使用清单**：每个 ref 工程被用在了哪里，哪些未用上及原因，哪些预期工程实际缺失。
5. 遇到的主要问题与解决方式。
6. 下一周（Android ADB + logcat 崩溃捕获）的接入点建议，不超过 5 条，并指出可以复用 `ref/midscene-example/android/` 的哪些结构。