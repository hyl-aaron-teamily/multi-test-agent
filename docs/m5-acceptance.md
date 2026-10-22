# Milestone 5 — acceptance evidence (2026-10-22)

Scope confirmed by the user on 2026-10-22: **prove the end-to-end flow works**; not every sample Issue has to be reproduced or localised.
All runs below are against **production** (`https://teamily.ai/chat`, Android `ai.teamily.mobile` 2.0.15 on 2211133C). Run directories are under `midscene_run/issues/` (local, gitignored); code and SKILL artifacts are committed.

## Tasks T0–T11

| # | Done | Evidence |
|---|---|---|
| T0 | ✅ | `scrcpy --version` 5.0.1 (SCRCPY_PATH); `pnpm autotest accounts check` → test + prod accounts logged in by cursor, sessions cached in `platform/secrets/sessions/` (gitignored); credential scan of artifacts + git history: 0 hits |
| T1 | ✅ | `issue/parse.ts`, `issue/classify.ts`, `platform/schema/test-plan.ts` (zod + JSON Schema), `issue/validate.ts`; all 10 Issues classified (`issue/unit.spec.ts`) |
| T2 | ✅ | `drivers/web.ts`, `drivers/android.ts`; `pnpm autotest skill smoke --surface desktop-web|mobile-web|android-app --env prod` → open conversation + send message by coordinates on all three |
| T3 | ✅ | `skills/teamily/` (SKILL.md, pages/, profiles/ ×3 prod + test, refs/, operations.md, plan-template.md, report-spec.md, nodes.ts); calibration self-check: all elements pass, failures go to `reviewQueue` with annotated image; `pnpm autotest nodes` |
| T4 | ✅ | `issue/planner.ts` + `issue/cli.ts` + console; 1594/2336/1329 plans; 1329 → 3 substitution checkboxes with reason; 1614 / 1922 → refusal reports (`1614-2026-10-21T12-49-34-749Z`, `1922-2026-10-21T12-49-32-533Z`) |
| T5 | ✅ | `executor/run.ts`: 1594 desktop-web full 1000 steps (`1594-2026-10-21T11-59-01-205Z`) |
| T6 | ✅ | `incident/android-recorder.ts`, `replay/screen-recorder.ts` (device-side `pkill -f com.genymobile.scrcpy.Server`, 6×30 s ring, time-window logs, clock offset, dropbox); `am crash` inside a real Issue run: `1329-2026-10-21T14-00-04-888Z/1329-s3-android-app-v1/incidents/1-crash` — merged.mp4 150 s, covers 153 s before trigger, stack readable, step 46 / action recorded |
| T7 | ✅ | `incident/web-recorder.ts`; web check-failed incident trace opened in `npx playwright show-trace` (actions, filmstrip, Network 683, Console 85) + `console.jsonl`, `network.har` |
| T8 | ✅ | `incident/bundle.ts`, `incident/viewer.ts`: same layout on both surfaces; `index.html` opened offline (video seeks to trigger, ops list, logs) |
| T9 | ✅ | `incident/replay.ts`: replay of the injected-crash bundle → verdict by the same rule + first deviating round (`replay-report.md`) |
| T10 | ✅ | `issue/report.ts` (report.md, result.json, Allure results), console issue flow: upload → draft → one-time confirmation → run → report with working evidence links |
| T11 | ✅ | see table below |

## Sample Issues (production)

| Issue | Category | Surface | Conclusion | Run |
|---|---|---|---|---|
| 1594 | bug-intermittent | desktop-web | 未复现（上限内未出现）— 1000 steps, max interval 918 ms, launched once, 0 vision calls | `1594-2026-10-21T11-59-01-205Z` |
| 2336 | feature | desktop-web | 未实现 — profile / Artifacts / CloudDoc each keep their own 🔔, no unified center (screenshots) | `2336-2026-10-21T12-46-04-006Z` |
| 2122 (single-account part) | feature | desktop-web | 未实现 — no Mentions/@me aggregate, no prominent badge on muted group; second-account part deferred per §A.2 | `2122-2026-10-21T12-00-39-790Z` |
| 1329 s1 like | bug-intermittent | android-app (substitutes iOS, confirmed) | 未复现 — 30 min / 186 rounds | `1329-2026-10-21T12-51-17-047Z` |
| 1329 s2 location link | bug-intermittent | android-app (substitutes iOS, confirmed) | 未复现 — 30 min / 278 rounds (CLI) and 268 rounds (console); first jump verified by accessibility read, later rounds compared to it | `1329-2026-10-21T14-54-17-540Z`, `1329-2026-10-21T16-46-03-066Z` |
| 1329 s2 — correction (2026-10-22) | — | — | Development runs that ended 已复现 (e.g. `1329-2026-10-21T16-43-05-544Z`) were false alarms: the recording shows the jump landing on the quoted message itself; the bubble wraps onto two lines in the narrow viewport and is briefly highlighted, so the strict baseline pixel check failed. Such hits now go through evidence review and are dismissed; the incident is kept as preset case `fixtures/evidence/1329-s2-quote-wrap` (see `docs/m6-acceptance.md`) | — |
| 1329 s3 keyboard | bug-intermittent | android-app (substitutes iOS, confirmed via console checkbox) | 未复现 — 30 min / 390 steps, max interval 964 ms | `1329-2026-10-21T16-05-57-933Z` |
| 1614 | server-side | — | 拒绝（§A.2） | `1614-2026-10-21T12-49-34-749Z` |
| 1922 | not-executable | — | 拒绝（§A.2 / T4）. The file is not empty as the doc assumed (iOS second-line-clipped bug); refused per the doc by user decision, recorded in `platform/issue-overrides.yaml` | `1922-2026-10-21T12-49-32-533Z` |
| 1919, 2235 | multi-account | — | 暂缓 | `1919-…`, `2235-…` |
| 2230 | deferred | — | 暂缓 | `2230-…` |

iOS has no execution surface in this project (§0: one Android phone); §A.2 prescribes substitution for 1329, and every 1329 report starts with the substitution notice.

## Acceptance §8

| # | Met | Evidence |
|---|---|---|
| 8.1 | ✅ | 10/10 Issues classified; plans / refusal / deferral reports as above |
| 8.2 | ✅ | 1594 run above (≤1 s, launched once, vision calls 0 in report stats) |
| 8.3 | ✅ | 2336, 2122 single-account part, one-time acceptance in production with missing items listed |
| 8.3a | ✅ | targets picked by the model at preparation (reports: “准备阶段目标 … [model]”); calibration self-check automatic, review queue only for failures |
| 8.3b | ✅ | `autotest accounts list|check`; leases by env/surface; credential scan 0 hits |
| 8.4 | ✅ | console, full 30 min runs: only s3 ticked → `--approve s3:android-app` (`1329-2026-10-21T16-05-57-933Z`); only s2 ticked → `--approve s2:android-app` (`1329-2026-10-21T16-46-03-066Z`, 268 rounds, 0 hits, max interval 966 ms, 0 vision calls). Checkboxes start unticked and show the reason; CLI `--approve s1,s3` / `s2:mobile-web` runs; reports marked 替代 |
| 8.5 | ✅ | crash bundle inside a 1329 run (T6 row): video playable, ≥30 s before trigger (153 s), windows aligned in incident.json, stack readable, step + action |
| 8.6 | ✅ | T7 row |
| 8.7 | ✅ | device-side pkill stop; 6-segment video ring; logs trimmed by time window |
| 8.8 | ✅ | `replay-report.md`: 能否复现 + 偏离点 |
| 8.9 | ✅ | `skills/teamily/`, profiles for 3 surfaces, nodes listed and used by plans, `SKILL 失效 @ 页面 home` raised on mismatch |
| 8.10 | ✅ | `pnpm test:unit` 67 passed, `pnpm typecheck` clean, `pnpm test:web` 1/1, `pnpm test:android` 5/5 |

## Known limits

- Vision judgements are reliable for picking targets, not for verdicts; verdict checks prefer region/ink matching and accessibility reads.
- Location-link (1329 s2) needs an existing quote reply in the conversation as precondition.
- Test messages posted to the production group during development were recalled (6 “你撤回了一条消息” notices remain).
