#!/usr/bin/env bash
# 故意破坏每个关键断言，确认测试会红。
# 用法：bash spikes/agent-core/scripts/sabotage.sh
set -u

SPIKE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$SPIKE/../.." && pwd)"
VITEST="$ROOT/node_modules/.bin/vitest"
ART="$SPIKE/.artifacts/sabotage"
mkdir -p "$ART"

MUTATIONS=(
  seq-gap
  drop-tool-events
  no-orphan-sweep
  optimistic-recovery
  no-lock
  no-reentry
  no-unique-index
  slow-lock
  approval-overwrite
  approval-always-allow
)

echo "baseline:"
"$VITEST" run --config "$SPIKE/vitest.config.ts" > "$ART/baseline.log" 2>&1
echo "  exit=$? $(grep -E 'Tests .*(passed|failed)' "$ART/baseline.log" | tail -1)"

for mutation in "${MUTATIONS[@]}"; do
  SPIKE_MUTATION="$mutation" "$VITEST" run --config "$SPIKE/vitest.config.ts" > "$ART/$mutation.log" 2>&1
  code=$?
  summary="$(grep -E 'Tests .*(passed|failed)' "$ART/$mutation.log" | tail -1)"
  echo "$mutation: exit=$code ${summary}"
  if [ "$code" -eq 0 ]; then
    echo "  WARNING: mutation $mutation did NOT turn the suite red"
  fi
done
