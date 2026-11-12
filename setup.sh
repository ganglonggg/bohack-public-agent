#!/usr/bin/env bash
# 一键部署：在服务器上 sudo bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"
SRC=$(pwd)
APP=/opt/teammate-agent
ENVF=/etc/teammate-agent.env
say(){ printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || exec sudo bash "$0" "$@"

# 1. Node
NODE=""
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  NODE=$(command -v node)
elif [ -x /opt/node/bin/node ]; then
  NODE=/opt/node/bin/node
else
  say "安装 Node.js（国内镜像）"
  case "$(uname -m)" in x86_64) A=x64;; aarch64|arm64) A=arm64;; *) die "不支持的 CPU 架构 $(uname -m)";; esac
  V=v20.18.1
  curl -fL --retry 3 "https://npmmirror.com/mirrors/node/$V/node-$V-linux-$A.tar.gz" -o /tmp/node.tgz || die "下载 Node 失败"
  rm -rf /opt/node && mkdir -p /opt/node && tar -xzf /tmp/node.tgz -C /opt/node --strip-components=1
  NODE=/opt/node/bin/node
fi
say "Node $($NODE -v)"

# 2. 代码（保留旧数据）
mkdir -p "$APP"
cp "$SRC/server.js" "$APP/"; mkdir -p "$APP/public"; cp "$SRC/public/index.html" "$APP/public/"
[ -f "$SRC/knowledge.md" ] && cp "$SRC/knowledge.md" "$APP/"

# 3. 配置
KEY=""; MODEL=deepseek-flash; ADMIN=""; PORT=80
if [ -f "$ENVF" ]; then
  . "$ENVF"
  KEY=${LLM_API_KEY:-}; MODEL=${LLM_MODEL:-$MODEL}; ADMIN=${ADMIN_KEY:-}; PORT=${PORT:-80}
fi
if [ -z "$KEY" ] || [ "${1:-}" = "--reset-key" ]; then
  read -rp "粘贴你的 DeepSeek API key（sk- 开头），回车： " KEY </dev/tty
  KEY=$(echo "$KEY" | tr -d '[:space:]')
fi
[ -n "$KEY" ] || die "没有填 key"
[ -n "$ADMIN" ] || ADMIN=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')

# 端口被别的程序占了，就换一个空闲的
busy(){ ss -ltn | awk '{print $4}' | grep -qE "[:.]$1\$"; }
systemctl stop teammate-agent 2>/dev/null || true   # 先停掉自己，剩下占着端口的就是别人
if command -v ss >/dev/null && busy "$PORT"; then
  OLD=$PORT; PORT=""
  for P in 80 8080 8090 8188 8288 8388; do busy "$P" || { PORT=$P; break; }; done
  [ -n "$PORT" ] || die "找不到空闲端口"
  say "$OLD 端口被占用，改用 $PORT（记得在腾讯云防火墙放通 $PORT）"
fi

# 4. 检查 key 和模型名
say "检查 DeepSeek key……"
check(){ curl -s -m 30 -o /tmp/llm.out -w '%{http_code}' https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$1\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":5}"; }
CODE=$(check "$MODEL" || true)
if [ "$CODE" != 200 ]; then
  for M in deepseek-flash deepseek-chat deepseek-v4-flash; do
    [ "$M" = "$MODEL" ] && continue
    if [ "$(check "$M" || true)" = 200 ]; then MODEL=$M; CODE=200; break; fi
  done
fi
if [ "$CODE" != 200 ]; then
  cat /tmp/llm.out 2>/dev/null; echo
  case "$CODE" in 401) die "key 不对，重新运行：sudo bash $SRC/setup.sh --reset-key";;
                  402) die "DeepSeek 账户余额不足，先去充值";;
                  *)   die "调用 DeepSeek 失败（HTTP $CODE），把上面的报错发给 Claude";; esac
fi
say "key 可用，模型：$MODEL"

umask 077
cat > "$ENVF" <<EOF
LLM_API_KEY=$KEY
LLM_MODEL=$MODEL
LLM_BASE_URL=https://api.deepseek.com
ADMIN_KEY=$ADMIN
PORT=$PORT
DATA_FILE=$APP/data/db.json
EOF

# 5. 开机自启服务
cat > /etc/systemd/system/teammate-agent.service <<EOF
[Unit]
Description=teammate agent
After=network-online.target
[Service]
EnvironmentFile=$ENVF
ExecStart=$NODE $APP/server.js
WorkingDirectory=$APP
Restart=always
RestartSec=2
LimitNOFILE=65535
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable teammate-agent >/dev/null 2>&1
systemctl restart teammate-agent
sleep 2
systemctl is-active --quiet teammate-agent || { journalctl -u teammate-agent -n 30 --no-pager; die "启动失败"; }
curl -fs "http://127.0.0.1:$PORT/api/config" >/dev/null || die "服务没响应：journalctl -u teammate-agent -n 50"

IP=$(curl -s -m 3 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 || true)
[ -n "$IP" ] || IP=$(curl -s -m 5 https://myip.ipip.net/s || echo 你的公网IP)
URL="http://$IP"; [ "$PORT" = 80 ] || URL="$URL:$PORT"
printf '\n\033[1;32m✓ 上线了！\033[0m\n\n  网站地址：  %s\n  后台人数：  %s/api/admin/stats?key=%s\n\n  打不开的话：去腾讯云控制台 → 防火墙/安全组，放通 TCP %s 端口。\n\n' "$URL" "$URL" "$ADMIN" "$PORT"
