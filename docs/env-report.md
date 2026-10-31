# Environment report (Step 0 — read-only reconnaissance)

Collected 2026-10-19 on the development machine. No system changes were made while collecting this.

## 0.1 OS and architecture

| Item | Value | Command |
|---|---|---|
| OS | Windows 11 Home China, `Microsoft Windows NT 10.0.26200.0` | `[System.Environment]::OSVersion` |
| Shell | Git Bash (MSYS2) `MINGW64_NT-10.0-26200 3.6.4 x86_64` | `uname -a` |
| CPU arch | AMD64 / x86_64 | `$env:PROCESSOR_ARCHITECTURE` |

## 0.2 Package managers and privileges

| Tool | Status |
|---|---|
| winget | available (`%LOCALAPPDATA%\Microsoft\WindowsApps\winget`) |
| choco | not installed |
| scoop | not installed |
| sudo / admin | n/a on Windows; shell is not elevated. winget user-scope installs do not need admin. |

## 0.3 adb

| Check | Result |
|---|---|
| `which adb` | not found in PATH |
| `adb version` | `adb: command not found` |
| `adb devices -l` | `adb: command not found` (cannot list devices) |

## 0.4 Existing Android toolchain traces

| Check | Result |
|---|---|
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | empty |
| `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` | not present |

No Android Studio / SDK on this machine.

## 0.5 Device state

Skipped: adb is not available, so the device cannot be queried yet. See `env-plan.md` execution log for the post-install check.

## 0.6 Node.js and project

| Item | Value |
|---|---|
| node | v22.23.2 |
| pnpm | 12.4.2 |
| git | 2.51.0.windows.1 |
| Java (for Allure CLI) | JDK 25.0.4.1 at `C:\Program Files\Java\jdk-25.0.4.1` (installed by user during week 1) |
| Model credentials | no `.env`, no `MIDSCENE_MODEL_*` in environment |
