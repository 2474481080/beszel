#!/bin/sh
# beszel-agent 离线安装脚本（二改版）——内网/无外网环境专用。
# 不下载任何东西：把 agent 二进制（或官方命名的 tar.gz）放在本脚本同目录即可。
#
# 用法：
#   ./install-agent-offline.sh -k "ssh-ed25519 AAAA..." -t TOKEN -url http://HUB_IP:PORT
#
# 安全默认（区别于在线脚本）：
#   * WebSocket 模式：agent 主动出站连 hub，本机不对外开任何端口
#   * SSH 通道只绑 127.0.0.1（--listen-public 才绑 0.0.0.0，供 hub 主动连接的场景）
#   * 不安装每日自更新定时器（内网连不上 GitHub，生产也不建议自动换二进制）
#   * 重复执行安全：已存在时只更新 KEY/TOKEN/HUB_URL/LISTEN，保留其它自定义
set -e

KEY=""
TOKEN=""
HUB_URL=""
PORT="45876"
LISTEN_PUBLIC="false"

usage() {
  printf "用法: %s -k KEY -t TOKEN -url http://HUB:PORT [-p 45876] [--listen-public]\n" "$0"
  printf "  -k KEY            hub 的 SSH 公钥（面板 添加系统 弹窗里有）\n"
  printf "  -t TOKEN          系统 token\n"
  printf "  -url URL          hub 地址（agent 出站可达即可）\n"
  printf "  -p PORT           SSH 通道端口，默认 45876\n"
  printf "  --listen-public   SSH 通道绑 0.0.0.0（hub 主动连 agent 的模式才需要）\n"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -k) KEY="$2"; shift 2 ;;
    -t) TOKEN="$2"; shift 2 ;;
    -url|--url) HUB_URL="$2"; shift 2 ;;
    -p) PORT="$2"; shift 2 ;;
    --listen-public) LISTEN_PUBLIC="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 2 ;;
  esac
done

if [ -z "$KEY" ]; then
  echo "缺少 -k KEY"; usage; exit 2
fi
if [ "$(id -u)" != "0" ]; then
  echo "请用 root 执行"; exit 2
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "本脚本只支持 systemd 系统"; exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
AGENT_DIR=/opt/beszel-agent
BIN_PATH=$AGENT_DIR/beszel-agent
UNIT_FILE=/etc/systemd/system/beszel-agent.service

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) ARCH="$(uname -m)" ;;
esac

# 找二进制：优先裸文件，其次官方命名 tar.gz
SRC_BIN=""
if [ -f "$SCRIPT_DIR/beszel-agent" ]; then
  SRC_BIN="$SCRIPT_DIR/beszel-agent"
else
  for tarball in "$SCRIPT_DIR/beszel-agent_linux_${ARCH}.tar.gz" "$SCRIPT_DIR/beszel-agent_linux_${ARCH}_glibc.tar.gz"; do
    if [ -f "$tarball" ]; then
      TMP=$(mktemp -d)
      tar -xzf "$tarball" -C "$TMP" beszel-agent
      SRC_BIN="$TMP/beszel-agent"
      break
    fi
  done
fi
if [ -z "$SRC_BIN" ]; then
  echo "找不到 agent 二进制。把 beszel-agent 或 beszel-agent_linux_${ARCH}.tar.gz 放到脚本同目录。"
  exit 2
fi

# 专用用户 + 目录
if ! id beszel >/dev/null 2>&1; then
  useradd --system --home-dir "$AGENT_DIR" --shell /usr/sbin/nologin beszel 2>/dev/null \
    || useradd -r -d "$AGENT_DIR" -s /sbin/nologin beszel
fi
if getent group docker >/dev/null 2>&1; then
  usermod -aG docker beszel 2>/dev/null || true
fi
mkdir -p "$AGENT_DIR"

systemctl stop beszel-agent 2>/dev/null || true
install -m 0755 "$SRC_BIN" "$BIN_PATH"
chown beszel:beszel "$BIN_PATH"

if [ "$LISTEN_PUBLIC" = "true" ]; then
  LISTEN="0.0.0.0:$PORT"
else
  LISTEN="127.0.0.1:$PORT"
fi

# 必检配置模板（已存在则不覆盖）
if [ ! -f "$AGENT_DIR/agent.env" ]; then
  cat > "$AGENT_DIR/agent.env" <<'EOF'
# 必检服务巡检配置，改完执行 systemctl restart beszel-agent 生效
# 业务 jar：查 进程+端口+nacos注册健康，格式 jar名[:端口][@nacos服务名]
#CHECK_SERVICES="order-service.jar:8080,pay-service.jar:9090@pay-svc"
# 数据库/中间件：只查 进程+端口
#CHECK_MIDDLEWARE="mysql:3306,redis:6379,nginx:80"
# nacos 地址（不配则 jar 只查进程+端口）
#NACOS_URL=http://10.0.0.5:8848
#NACOS_GROUP=DEFAULT_GROUP
#NACOS_NAMESPACE=
#NACOS_USERNAME=
#NACOS_PASSWORD=
EOF
  chmod 600 "$AGENT_DIR/agent.env"
fi

update_env_line() {
  key="$1"; val="$2"
  current=$(grep -oP "Environment=\"${key}=\K[^\"]*" "$UNIT_FILE" 2>/dev/null | head -1)
  if [ -z "$current" ]; then
    sed -i "/^\[Service\]/a Environment=\"${key}=${val}\"" "$UNIT_FILE"
  elif [ "$current" != "$val" ]; then
    esc=$(printf '%s' "$val" | sed 's/[&|\\]/\\&/g')
    sed -i "s|Environment=\"${key}=[^\"]*\"|Environment=\"${key}=${esc}\"|" "$UNIT_FILE"
  fi
}

if [ -f "$UNIT_FILE" ]; then
  update_env_line LISTEN "$LISTEN"
  update_env_line KEY "$KEY"
  [ -n "$TOKEN" ] && update_env_line TOKEN "$TOKEN"
  [ -n "$HUB_URL" ] && update_env_line HUB_URL "$HUB_URL"
  echo "已更新现有服务的连接参数。"
else
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Beszel Agent Service
Wants=network-online.target
After=network-online.target

[Service]
Environment="LISTEN=$LISTEN"
Environment="KEY=$KEY"
Environment="TOKEN=$TOKEN"
Environment="HUB_URL=$HUB_URL"
EnvironmentFile=-$AGENT_DIR/agent.env
ExecStart=$BIN_PATH
User=beszel
Restart=on-failure
RestartSec=5
StateDirectory=beszel-agent

# Security/sandboxing settings
KeyringMode=private
LockPersonality=yes
ProtectClock=yes
ProtectHome=read-only
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectSystem=strict
RemoveIPC=yes
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable beszel-agent >/dev/null 2>&1
systemctl restart beszel-agent
sleep 2
if systemctl is-active --quiet beszel-agent; then
  echo "安装完成：beszel-agent 运行中（LISTEN=$LISTEN，$([ -n "$HUB_URL" ] && echo "WebSocket 出站 -> $HUB_URL" || echo "等待 hub 连接")）"
  echo "必检配置：$AGENT_DIR/agent.env，改完 systemctl restart beszel-agent"
else
  echo "服务启动失败，查看日志: journalctl -u beszel-agent -n 20"
  exit 1
fi
