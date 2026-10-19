# Environment plan (Step 0.5 — minimal dependency decisions)

Based on `env-report.md`.

## A. Minimal dependency table

| Dependency | Required | Why | If missing |
|---|---|---|---|
| **adb** | yes | `@midscene/android` drives the device through adb | decision tree below |
| `ANDROID_HOME` | no | `AndroidDevice` accepts `androidAdbPath`; this project reads `MIDSCENE_ADB_PATH` and passes it through | set `MIDSCENE_ADB_PATH` in `.env` when adb is not on PATH |
| `@midscene/android` | yes | npm package | `pnpm add -D @midscene/android` |
| Android Studio / full SDK | no | adb can be installed on its own | **not installed** |
| USB debugging on device | yes | device-side setting | cannot be done by the agent; steps in README |

## B. adb decision (applied to this machine)

```
adb on PATH?            → no
package manager?        → winget available
  → winget install --id Google.PlatformTools -e --scope user   (planned, see log)
  if that fails/denied  → standalone platform-tools zip
                          https://dl.google.com/android/repository/platform-tools-latest-windows.zip
                          unzip to ./tools/platform-tools/ (git-ignored), use MIDSCENE_ADB_PATH
  if both fail          → record the blocker, build skeleton + readable errors, stop and report
```

## C. Project integration

`fixtures/android.ts` resolves adb as: `MIDSCENE_ADB_PATH` env → `./tools/platform-tools/adb(.exe)` if present → `adb` on PATH.
The resolved path is passed to `new AndroidDevice(udid, { androidAdbPath })` and to every `child_process` adb call, so nothing assumes adb is on PATH.

## Execution log

Commands that change the system are listed here **before** they run, with their result afterwards.

| # | Command | Changes system? | Result |
|---|---|---|---|
| 1 | `winget install --id Google.PlatformTools -e --scope user --accept-source-agreements --accept-package-agreements` | yes (user-scope install of Android platform-tools) | exit 0. Installed to `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe`; winget added the `adb` alias and updated user PATH (new shells only). |
| 2 | `adb version` | no | `Android Debug Bridge version 1.0.41`, `Version 37.0.1-15733141` |
| 3 | `adb devices -l` | no | `List of devices attached` followed by an empty list: **no device connected** |

### Status after install

- adb: available (see path above). Shells opened before the install do not see it on PATH, so set `MIDSCENE_ADB_PATH` in `.env` to the full path, or open a new terminal.
- Device: **none connected**. To proceed: enable Developer options and USB debugging on the phone, connect it by USB, accept the "Allow USB debugging" prompt on the device screen, then run `adb devices -l` again. If it shows `unauthorized`, tap Allow on the phone; do not work around it with `adb kill-server` loops.
- Blocker recorded: device-dependent DoD items (3, 4, 5 on a real device) cannot run until a device is attached.
