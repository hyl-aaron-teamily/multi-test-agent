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
