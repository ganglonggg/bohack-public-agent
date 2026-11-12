#!/bin/bash
# 双击运行：在本机启动找队友 agent，并自动打开浏览器
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-3000}

NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  NODE=$(command -v node)
else
  for p in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.bun/bin/node" ./.node/bin/node; do
    [ -x "$p" ] && NODE=$p && break
  done
fi
if [ -z "$NODE" ]; then
  echo "第一次运行，正在下载 Node.js（约 40MB）……"
  A=arm64; [ "$(uname -m)" = x86_64 ] && A=x64
  V=v20.18.1
  curl -fL --retry 3 "https://npmmirror.com/mirrors/node/$V/node-$V-darwin-$A.tar.gz" -o /tmp/node.tgz || { echo "下载失败"; read -r; exit 1; }
  mkdir -p .node && tar -xzf /tmp/node.tgz -C .node --strip-components=1
  NODE=./.node/bin/node
fi

lsof -ti tcp:$PORT 2>/dev/null | xargs kill 2>/dev/null
( sleep 1.5; open "http://localhost:$PORT" ) &
echo "关掉这个窗口就会停止。"
PORT=$PORT exec "$NODE" server.js
