#!/usr/bin/env bash
# 环境探测：codex 是否可用（CLI、原生二进制、凭据、provider 配置）
# 只读操作，不发起任何模型调用。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "== 1. PATH 中的 codex =="
if command -v codex >/dev/null 2>&1; then
  echo "codex in PATH: $(command -v codex)"
  codex --version 2>&1 | head -3
else
  echo "codex NOT in PATH"
fi

echo
echo "== 2. SDK 依赖包自带的原生二进制 =="
PKG="$ROOT/node_modules/@openai/codex/bin/codex.js"
if [ -f "$PKG" ]; then
  node "$PKG" --version 2>&1 | head -3
else
  echo "missing $PKG"
fi
BIN="$ROOT/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
echo "binary: $BIN"
if [ -x "$BIN" ]; then
  echo "binary executable: yes"
  ls -lh "$BIN" | awk '{print "size:", $5}'
else
  echo "binary executable: NO"
fi

echo
echo "== 3. 凭据 =="
test -n "${OPENAI_API_KEY:-}" && echo "env OPENAI_API_KEY: set" || echo "env OPENAI_API_KEY: unset"
test -n "${CODEX_API_KEY:-}" && echo "env CODEX_API_KEY: set" || echo "env CODEX_API_KEY: unset"
AUTH="$HOME/.codex/auth.json"
if [ -f "$AUTH" ]; then
  node -e "
    const a=require('$AUTH');
    console.log('~/.codex/auth.json: exists');
    console.log('  keys:', Object.keys(a).join(','));
    console.log('  has OPENAI_API_KEY field:', typeof a.OPENAI_API_KEY === 'string' && a.OPENAI_API_KEY.length > 0);
    console.log('  has tokens.access_token:', !!(a.tokens && a.tokens.access_token));
  " 2>&1
else
  echo "~/.codex/auth.json: MISSING"
fi

echo
echo "== 4. provider / model 配置（不含密钥） =="
CFG="$HOME/.codex/config.toml"
if [ -f "$CFG" ]; then
  grep -E '^(model|model_provider|model_reasoning_effort|approval_policy|sandbox_mode|web_search|base_url|name|wire_api) *=' "$CFG" | sed 's/^/  /'
else
  echo "~/.codex/config.toml: MISSING"
fi

echo
echo "== 5. 运行中的 codex 进程 =="
ps -Ao pid,command | grep -E 'codex-darwin-arm64|@openai/codex/bin' | grep -v grep || echo "  (none)"
