# home（会话列表）

| id | 含义 | 识别 | 区域 |
|---|---|---|---|
| nav.chat | 聊天入口 | 左栏 `aria-label^=聊天`；移动端底栏“聊天”；Android 底栏 Button desc=聊天 | 左栏 / 底栏 |
| nav.artifacts | Artifacts 入口 | `aria-label^=Artifacts` / 底栏 Artifacts | 左栏 / 底栏 |
| nav.me | 我（个人主页） | `aria-label^=我`；Android desc=我的（左上头像） | 左栏 / 左上 |
| chatlist.search | 会话搜索框 | placeholder=搜索 | 列表顶部 |
| popup.appBannerDismiss | 下载 App 弹窗“忽略”（仅 mobile-web） | dialog 内“忽略” | 屏幕中部 |

参考区域：`home/nav`（导航栏，SKILL 失效检测）。

会话行（动态，不标定）：列表列内高 56–96 CSS px 的可点行（Android 150–400 px 宽行）；群聊 = 头像为多人拼图或名称含逗号。免打扰群右侧有划线铃铛。
