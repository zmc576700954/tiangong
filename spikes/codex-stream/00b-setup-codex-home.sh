#!/usr/bin/env bash
# 准备一个可用的 CODEX_HOME（不动 ~/.codex）
# 原因：本机 ~/.codex/config.toml 里的 model_reasoning_effort="max" 在 codex-cli 0.135.0 上
# 直接解析失败（见 README「环境」一节），所以实验用一份最小可用配置 + 复用已有凭据。
set -euo pipefail

H="${1:-/tmp/codex-home}"
SRC="$HOME/.codex/auth.json"
CFG_SRC="$HOME/.codex/config.toml"

mkdir -p "$H"
if [ -f "$SRC" ]; then
  cp "$SRC" "$H/auth.json"
  chmod 600 "$H/auth.json"
else
  echo "WARN: $SRC 不存在，后续真实调用会失败（需先 codex login 或配置 API key）" >&2
fi

# 从原配置里提取 provider 三元组（避免把原文件整份复制进来再次触发解析错误）
PROVIDER="$(grep -E '^model_provider *=' "$CFG_SRC" | head -1 | sed 's/.*= *//; s/"//g')"
MODEL="$(grep -E '^model *=' "$CFG_SRC" | head -1 | sed 's/.*= *//; s/"//g')"
BASE_URL="$(grep -E '^base_url *=' "$CFG_SRC" | head -1 | sed 's/.*= *//; s/"//g')"
WIRE_API="$(grep -E '^wire_api *=' "$CFG_SRC" | head -1 | sed 's/.*= *//; s/"//g')"
PROV_NAME="$(grep -E '^name *=' "$CFG_SRC" | head -1 | sed 's/.*= *//; s/"//g')"

: "${PROVIDER:=openai}"
: "${MODEL:=MiniMax-M3.1-Flash-Preview}"
: "${BASE_URL:=https://api.minimaxi.com/v1}"
: "${WIRE_API:=responses}"
: "${PROV_NAME:=minimax}"

cat > "$H/config.toml" <<EOF
model_provider = "$PROVIDER"
model = "$MODEL"
model_reasoning_effort = "high"
web_search = "disabled"

[model_providers.$PROVIDER]
name = "$PROV_NAME"
base_url = "$BASE_URL"
wire_api = "$WIRE_API"
requires_openai_auth = true
EOF

echo "CODEX_HOME ready: $H (provider=$PROVIDER model=$MODEL base_url=$BASE_URL)"
