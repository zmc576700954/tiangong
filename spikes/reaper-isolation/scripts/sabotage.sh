#!/usr/bin/env bash
# 对抗对照：把被测实现换成三个故意破坏的版本，跑同一套契约测试。
# 期望：每个坏版本都至少让一条契约变红；若某个坏版本全绿，说明测试台是摆设。
set -u
cd "$(dirname "$0")/.."

VITEST="../../node_modules/.bin/vitest"
STATUS=0

for impl in sabotage:shared-registry sabotage:bare-pid sabotage:group-wide; do
  log="$(mktemp)"
  echo ""
  echo "================= REAPER_IMPL=$impl ================="
  NO_COLOR=1 REAPER_IMPL="$impl" "$VITEST" run --config vitest.config.ts tests/isolation.test.ts >"$log" 2>&1
  code=$?
  # 只打印被判定为红的契约条目与汇总，避免噪声
  grep -E "× C[0-9]|Tests  |Test Files" "$log" || true
  if [ "${code}" -ne 0 ]; then
    echo "[OK] ${impl} -> contract suite RED, exit=${code}"
  else
    echo "[BAD] ${impl} -> contract suite still GREEN, bench cannot detect isolation bugs"
    STATUS=1
  fi
  rm -f "$log"
done

echo ""
exit "$STATUS"
