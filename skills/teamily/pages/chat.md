# chat（会话页）

| id | 含义 | 识别 | 区域 |
|---|---|---|---|
| chat.composer | 消息输入框 | 最后一个可见 `[contenteditable=true]`；Android EditText | 底部 |
| chat.send | 发送按钮 | `aria-label=发送`（键入后出现）；Android 无标签：键盘收起后输入框工具行最右按钮 | 底部右侧 |
| chat.back | 返回列表（移动端） | `aria-label=返回`；Android desc=返回 | 左上 |

参考区域：`chat/composer`（空输入框；Android 键盘弹起时整体上移，检查允许纵向滑动搜索）。
发送：desktop-web 用 Enter；mobile-web 与 Android 点 chat.send（Android 先收键盘，Enter 在 RN 输入框里是换行）。
目标消息（动态）：别人发的普通文本消息，进入会话后由视觉模型定位；点赞按钮 = 长按该消息后出现的 👍 / 表情项。
