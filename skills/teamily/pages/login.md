# login / login-password

| id | 含义 | 如何识别（标定期） | 区域 |
|---|---|---|---|
| login.email | 邮箱输入框 | `input[type=email]` | 表单中部 |
| login.emailContinue | Continue with Email | 含 Email 的 submit 按钮 | 邮箱框下方 |
| login.password | 密码输入框 | `input[type=password]`（第二步出现） | 表单中部 |
| login.continue | Continue | 文本为 Continue 的 submit 按钮 | 密码框下方 |

自检：输入框用键入探针（点一下键入 4 个字符看框内像素变化，再删掉）；登录按钮由“到达 /chat”验证。
