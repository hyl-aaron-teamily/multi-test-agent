#!/usr/bin/env sh
# Code gate (W2-2 §2 N4 / T8): deterministic checks after every change, target ≤ 5 minutes. No device, no
# product account needed except the evidence-review preset cases (vision model; skipped with --no-model).
#   sh scripts/code-gate.sh [--no-model]
# Steps: typecheck → unit tests (incl. golden templates and the 4 W2-2 Issues' expectations) → evidence
# review preset cases (fixtures/evidence). Exit code = number of failed steps.
cd "$(dirname "$0")/.." || exit 1
t0=$(date +%s)
fails=0
step() {
  name=$1
  shift
  s=$(date +%s)
  if "$@" >".m5tmp/code-gate-$name.log" 2>&1; then
    echo "[gate] PASS $name ($(($(date +%s) - s))s)"
  else
    echo "[gate] FAIL $name ($(($(date +%s) - s))s) — see .m5tmp/code-gate-$name.log"
    tail -20 ".m5tmp/code-gate-$name.log"
    fails=$((fails + 1))
  fi
}
mkdir -p .m5tmp
step typecheck pnpm typecheck
step unit pnpm test:unit
if [ "$1" = "--no-model" ]; then
  echo "[gate] SKIP evidence cases (--no-model)"
else
  step evidence pnpm autotest evidence cases
fi
total=$(($(date +%s) - t0))
echo "[gate] $([ $fails -eq 0 ] && echo OK || echo "$fails step(s) failed") in ${total}s$([ $total -gt 300 ] && echo ' — over the 5 min budget')"
exit $fails
