# imui — im-loadtest 的界面层移植

`D:\projects\tensoropera\im-loadtest` 的 **imload** 绕过客户端，直接按协议压服务端：登录 → WS → `1003 SendMsg` → `2001 PushMsg`。它回答的是"服务端扛不扛得住"。
**imui** 把同一套模型搬到用户看得见的那一层：在真实客户端（Android App / chat-web）的输入框里打字、点发送，再在各客户端**界面上出现**那一刻计时。它回答的是"用户看到的收发表现如何"。

## 1. 功能对照

| imload（服务端协议） | imui（Web / 移动端界面） | 说明 |
|---|---|---|
| `python -m imload config` | `pnpm autotest imui config` | 打印解析后的配置 |
| `discover`（REST 列会话） | `imui discover --client …` | 读客户端会话列表上看得见的名字 |
| `probe`（每种类型 1 条） | `imui probe` | 每种类型 1 条，不受 `--yes-prod` 限制（与 imload 一致） |
| `run --duration --rate --ramp --drain --msg-types --payload-bytes --json` | 同名参数 | `--rate` 上限 2 条/秒/发送端（界面打字速度上限） |
| `--env test\|prod`、`--yes-prod` / `IMLT_PROD_CONFIRM` | `--env`、`--yes-prod` / `IMUI_PROD_CONFIRM=1` | Android App 连哪个后端由安装包决定，默认按生产处理（`IMUI_ANDROID_ENV=test` 可改） |
| 连接 = 账号 × 平台（`PLATFORM_IDS`） | 客户端 = `android:<udid>`、`web:<env>`（`--client` 可多次） | 每个客户端打开一个会话：`--client "android:4f2ebdf2@会话名"` |
| `SENDER` / `PEER_USER_ID` / `TARGET_MODE` 拓扑 | `--sender`（默认第一个客户端），其余客户端都是观察端 | 同账号两端 = 多端同步；不同账号 = 对端投递；单客户端 = 只测回显 |
| `ws_connect_ms` | `ui_ready_ms` 输出在日志 | 打开会话、输入框可用的耗时 |
| `send_ack_ms`（1003 回包） | **`ui_echo_ms`**：按发送 → 自己界面出现气泡 | |
| `end_to_end_ms`（2001 推送） | **`ui_e2e_ms`**：按发送 → 观察端界面出现气泡 | 同机同一时钟，无跨设备时钟偏差 |
| 投递按连接计（expected / delivered / lost / loss_ratio） | 按观察客户端计，口径相同 | |
| 推送去重，不计数 | **新增**：重复气泡数、乱序显示数、自身气泡未出现数 | imload 明确不统计重复和乱序 |
| `unexpected_pushes`（perfbot 自动回复） | 只认**以 token 开头**的气泡；回复里引用的 token 不计 | Teamily Personal AI 会回复"收到：imui-…" |
| SLO：`SLO_E2E_P99_MS` / `SLO_ACK_P99_MS` / `SLO_MAX_LOSS_RATIO`；有错误即失败 | `IMUI_SLO_E2E_P99_MS` / `IMUI_SLO_ECHO_P99_MS` / `IMUI_SLO_MAX_LOSS_RATIO`；重复、乱序、未回显、发送错误即失败 | 未配置的阈值只出报表 |
| 退出码 0 通过 / 2 SLO 失败 / 1 配置或连接错误 | 相同 | |
| `selftest.py`（假 UC + 假网关） | `imui selftest`（本机假聊天页 + 注入故障） | 6 个场景：无故障、延迟、丢失、重复、自动回复引用、乱序 |
| webui 控制台（127.0.0.1:8777） | `pnpm platform` 控制台的「IM 消息压测」任务 | 设备池分配 Android 设备，可选 Web 观察端 |
| probe/ 的 storageState 会话文件 | `imui login --env test` 保存 Web 登录态到 `.imui/web-<env>.json` | 工具不接触密码 |
| `websocketMaxMsgLen` 4096 | `--payload-bytes` ≤ 4096 | |

**未移植**：image / audio / video 消息（界面上需要选图、录音，属于下一步）；imload 的群发给所有好友 / 所有群（界面层会真实打扰他人，故意不做）；token 铸造、S3 上传等协议层功能（不属于界面层）。

## 2. 客户端如何实现

**Android（`imui/clients/android.ts`）：全程不调用模型。**

- **打开会话**：在无障碍树（`uiautomator dump`）里找到会话名并点击。
- **发送**：
  1. 键盘弹出状态下用 yadb 清空并输入。yadb 是 Midscene 自带的工具，可绕过输入法；中文九宫格输入法会把 `adb input text` 转成拼音。
  2. 收起键盘，避免输入法窗口遮挡按钮。
  3. 读回输入框，确认内容就是本条消息。
  4. 点击输入框下方工具栏最右的发送按钮。
  5. 确认输入框已被清空。任一步不符合就记为发送错误，不盲点。
- **观察**：轮询无障碍树。每次 dump 都参与观察，包括发送流程里的核验 dump。时间戳取 dump 时间窗的中点，报告里给出观察分辨率（测试机约 3 秒）。

**Web（`imui/clients/web.ts`）：Playwright + 保存的登录态。**

- **发送**：在输入框插入文字后按 Enter。
- **观察**：页面内的 MutationObserver 在节点进入 DOM 时上报，事件驱动，分辨率约 0。输入框内的文字不计入。

## 3. 用法

```bash
pnpm autotest imui selftest                                               # 离线，无需设备和账号
pnpm autotest imui discover --client android:4f2ebdf2
pnpm autotest imui probe    --client "android:4f2ebdf2@aaron+test3's Personal AI" --msg-types text,long
IMUI_SLO_ECHO_P99_MS=6000 pnpm autotest imui run \
  --client "android:4f2ebdf2@aaron+test3's Personal AI" \
  --duration 60 --rate 0.1 --msg-types text,long --payload-bytes 200 --drain 20 --yes-prod --json out.json

# Web 观察端 / 多端同步（同一账号在 Android 与 chat-web）：
pnpm autotest imui login --env test                                       # 弹出浏览器，手动登录后关闭
pnpm autotest imui run --client "android:<udid>@<会话>" --client "web:test@<会话>" --sender android:<udid> ...
```

报告：`midscene_run/imui/<ts>-<runId>/report.md|json`。调试：`IMUI_DEBUG=1` 打印 dump、按下、看到的时间线。

## 4. 真机验证（Xiaomi 2211133C / Android 16，Teamily 生产，账号自己的 Personal AI 会话）

| 运行 | 结果 |
|---|---|
| `imui selftest` | 6/6 通过（注入 800ms 延迟测得 e2e p50 ≈ 860ms；每 3 条丢 1 条测得 lost=2；每 2 条重复 1 次测得 dup=3；乱序被检出；自动回复引用不计重复） |
| `imui probe`（text + long） | 2/2 发出并回显，echo ≈ 2.9 s |
| `imui run` 60 s，rate 0.1，text + long，SLO echo p99 ≤ 6000ms | 3 条发出，3 条回显，echo p50 3.38 s、p99 3.64 s，**PASS**，退出码 0 |
| 控制台「IM 消息压测」任务 | queued → running → completed，PASS，2 条，echo p50 3.2 s |

调试过程中在真机上暴露并修复的问题见 CHANGELOG。期间**没有误发内容**：误触的语音录制已删除，误开的表情面板、全屏编辑器、输入法剪贴板面板都已关闭；测试只往账号自己的 Personal AI 会话发了带 `imui-` 前缀的消息。

## 5. 限制

- **观察端投递（`ui_e2e_ms`、丢失率）尚未在真机上跑过**：需要第二个客户端，可以是第二台手机、模拟器，或用 `imui login` 登录 chat-web。Web 客户端目前只经过本机假页面的自测。
- **Android 实际发送速率约 0.04–0.05 条/秒**：每条约 20 秒，包括聚焦、清空、输入、核验、发送、确认。`--rate` 只是上限。这是界面层测试的固有成本；需要大流量时请用 imload。
- **观察分辨率约 3 秒**（`uiautomator dump` 本身的耗时）：Android 端延迟数值包含最多一个轮询周期的误差。AI 流式回复期间界面不空闲，dump 会失败，失败次数记在报告里。
- **只支持 ASCII 消息内容**：token 用于识别气泡。
- **Web 选择器只针对通用结构**：会话按可见名称点击，输入框取最后一个可见的 contenteditable 或 textarea；`IMUI_WEB_INPUT` 可覆盖。真实 chat-web 页面还没有登录验证过。
