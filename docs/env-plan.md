# 环境计划：AndroidWorld 评测环境（W2-5 P1）

按 F14：会修改系统的命令先写在这里，执行后在「结果」栏补记。全部由用户手动执行；每步的「检查」输出贴回给开发者即可。

## 0. 本机现状（2026-11-03 读取）

| 项 | 值 |
|---|---|
| CPU / 内存 / 显卡 | AMD Ryzen 7 H 260（16 线程）/ 32 GB / Radeon 780M + NVIDIA RTX 5060 Laptop（模拟器 `-gpu host` 实际选用 RTX 5060 的 Vulkan） |
| 磁盘 | C: 463 GB 可用，D: 463 GB 可用 |
| adb | winget 的 platform-tools 37.0.1（`C:\Users\hyl20\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe`），测试手机在用 |
| Java | 25（sdkmanager 可用） |
| ffmpeg | winget 8.1.1（AndroidWorld 的音频任务需要） |
| Python | 系统 3.12；miniconda base 为 3.11.13（另有多个 3.11 环境，不动）；pip 全局源是阿里云镜像，镜像上查不到 `android-env`，官方源可达 |
| Docker Desktop / WSL | 已装（所以 Hyper-V 在用，模拟器加速只能用 WHPX） |
| Android SDK / 模拟器 | 没有 |

## 1. 选型（按性能）

| 项 | 选择 | 理由 |
|---|---|---|
| 运行方式 | Windows 原生模拟器 + 原生 Python | Docker 方式要在 WSL2 里再套一层虚拟化（嵌套），最慢 |
| 加速 | WHPX（Windows 虚拟机监控程序平台） | Docker / WSL2 占着 Hyper-V，AEHD 与它冲突 |
| 系统镜像 | `system-images;android-33;google_apis;x86_64` | AndroidWorld 指定 API 33；x86_64 在 AMD 上原生执行；`google_apis` 比带 Play 商店的镜像轻，且允许 `adb root`（AndroidWorld 需要） |
| AVD | Pixel 6，名字 `AndroidWorldAvd`，4 核、4 GB 内存、8 GB 数据分区 | AndroidWorld 指定 Pixel 6；4 核 4 GB 给宿主和模型调用留足余量 |
| 渲染 | `-gpu host`（780M） | 最快；画面异常时退回 `swiftshader_indirect` |
| 启动参数 | `-no-snapshot -grpc 8554 -no-boot-anim` | AndroidWorld 要求 `-no-snapshot` 与 `-grpc 8554`；不加 `-no-audio`（录音任务要麦克风） |
| adb | 只用现有的 winget adb，一个 adb 服务同时管手机和模拟器 | 两个不同版本的 adb 会互相杀掉对方的服务，手机连接会断。**不要把 SDK 自带的 platform-tools 加进 PATH** |
| Python | 用 miniconda base 的 3.11.13 建独立 venv（不重复装解释器，不改现有 conda 环境） | AndroidWorld 的锁定版本（matplotlib 3.6.1、numpy 1.26.3 等）没有 3.12 的预编译包 |
| AndroidWorld 源码 | 复制 `ref/android_world` 到 `D:\envs\android_world-src` 再安装 | 安装时会生成 protobuf 文件写进源码目录；`ref/` 只读（I13） |

## 2. 步骤

| # | 操作 | 命令 / 做法 | 检查 | 结果 |
|---|---|---|---|---|
| 1 | 开启「Windows 虚拟机监控程序平台」，重启 | 「启用或关闭 Windows 功能」→ 勾选「Windows 虚拟机监控程序平台」；或管理员 PowerShell：`Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All` | 重启后第 4 步的 `emulator -accel-check` 输出含 `WHPX` | 用户完成；`emulator -accel-check`：`WHPX(10.0.26200) is installed and usable` |
| 2 | 下载 Android 命令行工具 | https://developer.android.com/studio#command-line-tools-only 的 Windows 版 zip；解压后把里面的 `cmdline-tools` 目录内容放到 `D:\Android\Sdk\cmdline-tools\latest\`（应有 `D:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat`） | `D:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat --version` 输出版本号 | 用户完成 |
| 3 | 设置用户环境变量 | `ANDROID_HOME=D:\Android\Sdk`；PATH 追加 `D:\Android\Sdk\emulator` 与 `D:\Android\Sdk\cmdline-tools\latest\bin`（**不加** `platform-tools`） | 新开终端：`where adb` 第一行仍是 winget 的 adb；`where emulator` 在第 4 步后有结果 | 用户完成（`ANDROID_HOME=D:\Android\Sdk`） |
| 4 | 装模拟器与系统镜像 | `sdkmanager --licenses`（全部 y）；`sdkmanager "emulator" "system-images;android-33;google_apis;x86_64"` | `emulator -accel-check` 输出含 `WHPX` 且 `is installed and usable` | 用户完成；模拟器 37.2.13.0 |
| 5 | 建 AVD | `avdmanager create avd -n AndroidWorldAvd -k "system-images;android-33;google_apis;x86_64" -d pixel_6`（问是否自定义硬件时回 no） | `emulator -list-avds` 输出 `AndroidWorldAvd` | 用户完成 |
| 6 | 改 AVD 配置 | 编辑 `C:\Users\hyl20\.android\avd\AndroidWorldAvd.avd\config.ini`，设：`hw.ramSize=4096`、`hw.cpu.ncore=4`、`disk.dataPartition.size=8G`、`hw.gpu.enabled=yes`、`hw.gpu.mode=host`、`hw.keyboard=yes` | 文件里这 6 行都在 | 用户完成（`hw.ramSize=4G`，生效为 4 GB） |
| 7 | 首次启动模拟器 | `emulator -avd AndroidWorldAvd -no-snapshot -grpc 8554 -no-boot-anim -gpu host` | 窗口出现桌面；`adb devices` 同时列出手机和 `emulator-5554`；`adb -s emulator-5554 root` 输出 `restarting adbd as root` 或 `already running as root` | 首次报 `Cannot find AVD system path`：模拟器要求 SDK 根下有 `platform-tools` 目录才认 SDK。处理：`mklink /J D:\Android\Sdk\platform-tools <winget 的 platform-tools 目录>`（目录联接，仍是同一个 adb 37.0.1，不引入第二个版本）。之后启动成功：`emulator-5554` 与手机 `4f2ebdf2` 同时在线，`adb root` 成功，API 33、4 GB、4 核 |
| 8 | 装 Python 3.11 | python.org 的 3.11 最新版 Windows x64 安装包，勾选 py launcher，不勾「Add to PATH」 | `py -3.11 --version` 输出 3.11.x | 跳过：用 miniconda base 的 3.11.13 |
| 9 | 建虚拟环境、复制源码 | `py -3.11 -m venv D:\envs\androidworld`；把 `D:\projects\Tools\multi-test-agent\ref\android_world` 整个复制为 `D:\envs\android_world-src` | `D:\envs\androidworld\Scripts\python --version` 输出 3.11.x | `C:\Users\hyl20\miniconda3\python.exe -m venv D:\envs\androidworld`；源码复制时去掉 `.git` |
| 10 | 装依赖（官方源；需要时设代理） | `D:\envs\androidworld\Scripts\python -m pip install -i https://pypi.org/simple -r D:\envs\android_world-src\requirements.txt fastapi uvicorn`；然后 `D:\envs\androidworld\Scripts\python -m pip install -i https://pypi.org/simple D:\envs\android_world-src` | `D:\envs\androidworld\Scripts\python -c "import android_world, android_env, fastapi; print('ok')"` 输出 `ok` | 两条命令均成功；`import android_world, android_env, fastapi` 输出 ok（Windows 原生可用，不需要 WSL 回退） |
| 11 | 确认能下载 AndroidWorld 的 App | AndroidWorld 首次初始化从 `storage.googleapis.com` 下载约 20 个 APK；不通就在第 13 步前给终端设 `HTTPS_PROXY` | `curl -I https://storage.googleapis.com/gresearch/android_world/` 有 HTTP 响应（403 / 404 也算通） | 未完成：开发者这边的联网检查命令被权限拦下，需用户执行 |
| 12 | 告诉开发者已完成 | 贴回第 1、4、7、10、11 步的检查输出；模拟器保持开着 | — | |

第 12 步之后由开发者做（不需要你操作）：

| # | 操作 | 说明 |
|---|---|---|
| 13 | 检查 `android_env` 的 adb 控制器有没有 `adb kill-server` | **已查：有。** `android_env/components/adb_controller.py:75-92` 的 `_restart_server` 执行 `kill-server`，任何一条设备命令失败、重试前都会调用（第 145 行）。评测服务启动时把 `AdbController._restart_server` 替换成抛错 |
| 14 | 首次初始化 | `bench/androidworld/server.py --setup`：装 App、授权限，几分钟 |
| 15 | 往模拟器装读树服务 `ai.autotest.a11y` | 已预先同意的安装（与手机同一 APK） |

## 3. 回退

- 第 10 步 `import android_env` 在 Windows 上失败：贴回报错。回退方案是 Python 跑在 WSL2 的 Ubuntu 里，通过 `ADB_SERVER_SOCKET=tcp:<Windows 主机 IP>:5037` 用 Windows 上的同一个 adb 服务，gRPC 连 `<Windows 主机 IP>:8554`；到时开发者给出逐条命令。
- 第 7 步画面异常或模拟器崩溃：改用 `-gpu swiftshader_indirect`，并把 `config.ini` 的 `hw.gpu.mode` 改成同值。
- 卸载：删除 `D:\Android`、`D:\envs\androidworld`、`D:\envs\android_world-src`、`C:\Users\hyl20\.android\avd\AndroidWorldAvd.*`，去掉第 3 步的环境变量，按需关闭第 1 步的 Windows 功能。
