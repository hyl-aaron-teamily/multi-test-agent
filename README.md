# multi-test-agent

AI 驱动的 Web 自动化测试脚手架：**Midscene（AI 视觉定位/断言）+ Playwright（浏览器驱动）+ Vitest（运行器）+ Allure（报告）**。
用 https://www.saucedemo.com 的 5 步登录流程演示「AI 定位 + 结构化断言 + 失败可诊断」。

> **第一周只覆盖 Web；Android ADB / Hybrid WebView / 小程序 H5 / 闪退复现 / Monkey / 控制台均为后续里程碑，本仓库尚未实现。**

## 环境要求

- Node.js ≥ 18（已在 22 验证），pnpm（已在 12.4 验证）
- **Java 8+**（仅 `pnpm report` 需要：`allure-commandline` 是 Allure 2 的 Java CLI）
- 一个 OpenAI 兼容的视觉模型端点（Qwen3-VL / Doubao / Gemini / GPT 等）

## 环境变量

`cp .env.example .env` 后填写。变量名即 `@midscene/web` 实际读取的名称。

| 变量 | 必填 | 说明 |
|---|---|---|
| `MIDSCENE_MODEL_BASE_URL` | 是 | 模型 API 地址，如 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `MIDSCENE_MODEL_API_KEY` | 是 | API Key |
| `MIDSCENE_MODEL_NAME` | 是 | 模型名，如 `qwen3-vl-plus` |
| `MIDSCENE_MODEL_FAMILY` | 是 | 模型族，如 `qwen3-vl` / `doubao-vision` / `gemini` / `gpt-5` |
| `HEADLESS` | 否 | `false` 时显示浏览器窗口 |
| `MIDSCENE_CACHE` | 否 | `true` 时复用 AI 规划/定位缓存 |

缺少必填变量时，用例在 `beforeEach` 抛出 `MissingModelCredentialsError: [waiting for credentials] ...`，不会跳过或伪造 AI 步骤。

## 命令

```bash
pnpm install                              # 安装依赖（esbuild/sharp 构建脚本已在 pnpm-workspace.yaml 放行）
pnpm exec playwright install chromium     # 下载浏览器
pnpm test                                 # 运行用例，写入 ./allure-results 与 ./midscene_run/report
pnpm report                               # allure generate → ./allure-report（需要 Java）
pnpm exec allure open ./allure-report     # 打开报告
pnpm typecheck                            # tsc --noEmit
```

报告内容：每个业务步骤是一个 Allure step，步骤结束（成功或失败）都附整页截图；失败断言会标在对应 step 上。
用例结束还会把 Midscene 自带的 HTML 回放报告（每次 AI 调用的截图与模型推理）作为附件挂到 Allure。

## 目录结构

```
.
├── .env.example                 # 模型端点配置模板
├── package.json                 # test / report / typecheck 脚本
├── pnpm-workspace.yaml          # pnpm 构建脚本白名单（esbuild, sharp）
├── tsconfig.json                # strict, ESNext, ES2022
├── vitest.config.ts             # dotenv + allure-vitest reporter + 超时
├── fixtures/
│   └── page.ts                  # 浏览器/页面/PlaywrightAgent 生命周期、凭据检查、step()+截图
├── tests/web/
│   └── saucedemo.login.spec.ts  # 5 步登录流程
├── scripts/
│   └── report.ts                # 检查 Java 后调用 allure generate
└── ref/                         # 只读参考工程（不参与构建）
```

未创建 `playwright.config.ts`（不使用 `@playwright/test` runner，浏览器由 fixture 直接启动）与 `midscene.config.ts`（Midscene 只通过环境变量配置，类型定义中没有集中配置文件）。

## 依赖说明

核心：`@midscene/web`、`vitest`、`allure-vitest`、`allure-commandline`、`playwright`、`dotenv`。
另外三个必须的配套包：
- `@playwright/test`：`@midscene/web/playwright` 运行时导入它（peer），缺失会报 `Cannot find package '@playwright/test'`；官方 `playwright-with-vitest-demo` 同样声明了它。仅作依赖，不用它的 runner。
- `allure-js-commons`：`allure.step()` / `allure.attachment()` 运行时 API 所在包，pnpm 严格模式下必须直接声明，版本与 `allure-vitest` 一致。
- `typescript` / `tsx` / `@types/node`：类型检查与运行 `scripts/report.ts`。

## 后续路线

第 2 周接入 Android ADB（`@midscene/android`）+ logcat 崩溃捕获，随后是 WebView/小程序 H5、高频循环复现、Monkey 和 CLI/轻量控制台。

## 参考工程使用清单

| ref 工程 | 用在哪里 | 备注 |
|---|---|---|
| `midscene-example/playwright-with-vitest-demo/` | `fixtures/page.ts`（共享 browser + 每用例 page/PlaywrightAgent、groupName/reportFileName）、`vitest.config.ts`（dotenv、超时）、`tsconfig.json`、测试 describe/it 组织、`.env.example` 变量名 | 主要参考。官方没有 `createMidsceneWebTest` 之类 Vitest 集成导出，该示例本身就是 PlaywrightAgent + Vitest 钩子 |
| `midscene-example/playwright-demo/` | `chromium.launch` 参数；`aiWaitFor`/`aiQuery<T>`/`aiTap`/`aiAssert` 用法 | |
| `playwright-mind/` | 用例中「AI 操作 → aiQuery 结构化取数 → expect 断言 → aiAssert」的分工 | 其 `PlaywrightAiFixture` 依赖 `@playwright/test` runner，与 Vitest 栈不符，未采用 |
| `midscene-example/android/` | 未使用 | 第 2 周参考 |
| `midscene-example/puppeteer-demo` 等其余示例 | 未使用 | 与本周范围无关 |
| 预期的 `puppeteer-with-vitest-demo/` | **缺失** | 由 `playwright-with-vitest-demo/` 替代（更贴合） |
| 预期的社区完整 DEMO（Playwright+Midscene+Vitest+Allure） | **缺失** | `.env.example` 改为参照官方 demo README 与 `@midscene/shared` 类型定义 |
| 预期的 Allure Vitest 示例 `vitest-pnpm-ts/` | **缺失** | 改为参照 `node_modules/allure-vitest/README.md` 与 `allure-js-commons` 类型定义 |
