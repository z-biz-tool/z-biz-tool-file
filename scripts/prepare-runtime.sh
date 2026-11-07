#!/bin/zsh
# 组装「离线捆绑的 AI 运行时」到 src-tauri/runtime/，供 Tauri resources 打包。
#
# 它包含三样东西（装完即用，不依赖用户机器上的 node/npm/网络）：
#   runtime/bin/node         —— 独立 node 可执行（~110M）
#   runtime/lib/pi/          —— 捆绑的 Pi agent（@earendil-works/pi-coding-agent）
#   runtime/agent-proxy/dist —— agent-proxy 前端 JS（自包含，无第三方 require）
#
# 为什么不入库（.gitignore 已忽略）：整套 ~226M，且是「编译/安装产物」。
# 但脚本要能重跑，让任何一台机器克隆仓库后都能重建出 runtime 打包。
#
# 用法：  scripts/prepare-runtime.sh
#
# 依赖：
#   - node: 取 `NODE_BIN`，否则 PATH 里挑一个
#   - npm:  装 pi 用（`NPM_BIN` 或 PATH）
#   - agent-proxy dist: 默认从 ../z-biz-tool-worker/agent-proxy/dist 拷
#     （可传 AGENT_PROXY_DIST 覆盖）

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RT="$ROOT/src-tauri/runtime"

# 1) node 可执行
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "❌ 找不到 node。设 NODE_BIN=/path/to/node 或先装 Node.js 18+"
  exit 1
fi

# 2) npm
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
if [ -z "$NPM_BIN" ]; then
  echo "❌ 找不到 npm。设 NPM_BIN 或先装 Node.js（自带 npm）"
  exit 1
fi

echo "▶ 使用 node: $NODE_BIN ($("$NODE_BIN" --version))"
echo "▶ 使用 npm : $NPM_BIN"

# 3) agent-proxy dist 来源（默认 worker 原仓）
AGENT_PROXY_DIST="${AGENT_PROXY_DIST:-$ROOT/../z-biz-tool-worker/agent-proxy/dist}"
if [ ! -d "$AGENT_PROXY_DIST" ]; then
  echo "❌ 没有 agent-proxy dist: $AGENT_PROXY_DIST（传 AGENT_PROXY_DIST 覆盖）"
  exit 1
fi

mkdir -p "$RT/bin" "$RT/agent-proxy"
echo "▶ 拷贝 node → $RT/bin/node"
cp "$NODE_BIN" "$RT/bin/node"
chmod +x "$RT/bin/node"

echo "▶ 拷贝 agent-proxy dist"
rm -rf "$RT/agent-proxy/dist"
cp -R "$AGENT_PROXY_DIST" "$RT/agent-proxy/dist"

# 4) pi
mkdir -p "$RT/lib/pi"
echo "▶ 安装内置 Pi (bundled) → $RT/lib/pi"
cat > "$RT/lib/pi/package.json" <<'EOF'
{ "name": "bundled-pi", "private": true, "version": "1.5.0" }
EOF
# 用独立的 HOME 跑 npm，避免污染 ~/.npm 缓存里的东西（不影响）——不需要，直接装。
"$NPM_BIN" install --prefix "$RT/lib/pi" --no-audit --no-fund \
  @earendil-works/pi-coding-agent@1.5.0 >/dev/null

echo ""
echo "✅ runtime 就绪："
du -sh "$RT" "$RT/bin/node" "$RT/lib/pi" "$RT/agent-proxy"
echo ""
echo "  打包时 tauri.conf.json 的 bundle.resources 会把这三个目录带进 app。"