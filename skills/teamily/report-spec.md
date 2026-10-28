# 现场包结构

```
<run-dir>/<plan-id>/incidents/<n>-<kind>/
├── index.html      离线时间轴查看器（视频 + ops 字幕 / trace 链接 + 操作列表 + ±15 s 日志）
├── incident.json   触发类型/时间、窗口起止、时钟偏移、执行端/替代、设备/浏览器/App 版本、步号、动作、最后 30 个操作
├── video/          Android：scrcpy 分段 mkv（≤6×30 s）+ merged.mp4 + ops.srt
├── trace/          Web：trace-chunk-*.zip（`npx playwright show-trace`）
├── logs/           logcat-window.txt、crash-buffer.txt、dropbox.txt / console.jsonl、network.har
├── steps/          最近 10 轮检查点截图
├── state/          meminfo、activity
└── replay.json     coord-v1：setupOps + 最近 ≤21 轮坐标操作（含轮末帧哈希）+ 判定规则 + 检查
```

运行目录（W2-2）：`manifest.json`（工具 / 目标 / 设备 / 账号与会话名 / 运行标记 / 预检及其设置改动，不含凭据；也是 `trajectory.jsonl` 首条事件和报告头）；Web 运行无结论（执行失败 / 计划不可执行）时 `trace.zip` + `trace-1.zip`（飞行记录器最后两个块）。系列运行：`midscene_run/series/<issue>-<sub>-<surface>-<时间>/series-report.md` + `series.json` + `run-NN/`。

kind：crash / anr / app-exit / check-failed / console-error / page-error / visual-anomaly / watchdog。
重放：`pnpm autotest replay <incident>/replay.json [--variant original|fast|slow|cold|all]` → `replay-report.md`（能否复现 + 偏离点）。
