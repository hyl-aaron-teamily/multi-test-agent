#!/usr/bin/env sh
# W2-4 §7.6 in Claude Code itself: a headless `claude -p` session whose only tools are the autotest MCP tools
# (no built-in tools: --tools ""; only this server: --strict-mcp-config). The server is passed inline with
# --mcp-config, so no IDE / user configuration is written (G7). The stream (every tool call and result) is
# the evidence.
#   sh scripts/w2m4-claude-code-mcp.sh [issue] [out.ndjson]
cd "$(dirname "$0")/.." || exit 1
ISSUE=${1:-2010}
OUT=${2:-docs/w2m4/claude-code-mcp-$ISSUE.ndjson}
NODE=$(node -p "process.execPath.replace(/\\\\/g, '/')")
ROOT=$(node -p "process.cwd().replace(/\\\\/g, '/')")
CFG="{\"mcpServers\":{\"autotest\":{\"command\":\"$NODE\",\"args\":[\"$ROOT/node_modules/tsx/dist/cli.mjs\",\"$ROOT/scripts/mcp.ts\"]}}}"
PROMPT="You are an agent using the autotest black-box test platform through its MCP tools only. Follow docs/agent-rules.md (its rules are in the server instructions). Reproduce Issue $ISSUE once on the android-app surface: 1) call doctor and stop if the conclusion is blocked; 2) draft_show for issue $ISSUE (draft_create only if there is no draft) and pick the android-app plan id; 3) plan_explain it and state in one sentence what will be sent where and how long it takes; 4) task_run with that planId and the hash from plan_explain (one run, no series); 5) call task_wait with the task id repeatedly until the code is no longer STILL_RUNNING; 6) result_show. Finish with the conclusion sentence, the valid attempts and hits, exactly as result_show gives them. Never approve plans yourself."
mkdir -p "$(dirname "$OUT")"
claude -p "$PROMPT" --tools "" --strict-mcp-config --mcp-config "$CFG" --allowedTools "mcp__autotest__*" --output-format stream-json --verbose > "$OUT"
echo "[claude-code-mcp] exit $? → $OUT"
