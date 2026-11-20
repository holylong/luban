#!/usr/bin/env bash
# 把一套已经在跑的 luban relay 挂到 Cloudflare 隧道后面：源站 IP 不出现在任何
# DNS 记录里，也不需要域名备案。线路与取舍见 docs/relay.md。
#
# 前置（这套脚本不代做，因为都要你的账号）：
#   1. 有一个域名，并已托管在 Cloudflare（免费域名清单见 docs/relay.md）。
#   2. Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel（Cloudflared），
#      复制它给出的 token；在 Public Hostname 里加一条：
#        subdomain/domain = relay.example.com
#        service          = https://localhost:443   （勾上 No TLS Verify）
#   3. 本机已经装好 cloudflared（脚本会检查，装法见文档）。
#
# 用法：
#   sudo ./scripts/setup-relay-tunnel.sh --domain relay.example.com --token <TUNNEL_TOKEN>
#   sudo ./scripts/setup-relay-tunnel.sh --domain relay.example.com --token <T> --dry-run
#
# 脚本做三件事，全部可重复执行：
#   a. cloudflared service install <token>      装成系统服务（systemd/launchd）
#   b. 把 luban-relay 的 --public-url 改成 https://<domain>，备份原 unit 后重启
#   c. 等域名可用后逐个探活：/m/、静态资源、未授权的 /api/node
set -euo pipefail

DOMAIN=""
TOKEN=""
ORIGIN="https://localhost:443"
RELAY_SERVICE="luban-relay"
DRY_RUN=0
SKIP_RELAY_URL=0

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain 需要一个域名}"; shift 2 ;;
    --token) TOKEN="${2:?--token 需要隧道 token}"; shift 2 ;;
    --origin) ORIGIN="${2:?--origin 需要一个 URL}"; shift 2 ;;
    --relay-service) RELAY_SERVICE="${2:?}"; shift 2 ;;
    --skip-relay-url) SKIP_RELAY_URL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1（--help 查看用法）" >&2; exit 2 ;;
  esac
done

DNS_RE='^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'
[[ "$DOMAIN" =~ $DNS_RE ]] || { echo "域名不合法：${DOMAIN:-<空>}" >&2; exit 2; }
[ -n "$TOKEN" ] || { echo "缺少 --token（Zero Trust 隧道页给出的那串）" >&2; exit 2; }
case "$ORIGIN" in http://*|https://*) ;; *) echo "--origin 必须是 http(s):// 开头：$ORIGIN" >&2; exit 2 ;; esac

PUBLIC_URL="https://${DOMAIN}"
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

# ---------------------------------------------------------------- 前置检查
echo "== 检查 cloudflared =="
CF="$(command -v cloudflared || true)"
if [ -z "$CF" ]; then
  for candidate in /usr/local/bin/cloudflared /usr/bin/cloudflared "$HOME/apps/bin/cloudflared" "$HOME/.local/bin/cloudflared"; do
    if [ -x "$candidate" ]; then CF="$candidate"; break; fi
  done
fi
if [ -z "$CF" ]; then
  echo "没找到 cloudflared。装法（Linux 免 root，选一个）：" >&2
  echo "  curl -fL -o ~/apps/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" >&2
  echo "  chmod +x ~/apps/bin/cloudflared   # 国内直连 GitHub 很慢时，先在本机下好再 scp" >&2
  exit 1
fi
"$CF" --version | sed 's/^/  /'

if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" != "0" ]; then
  echo "安装服务、改 unit 需要 root，请用：sudo $0 $*" >&2
  exit 1
fi

# ---------------------------------------------- a. cloudflared 装成系统服务
echo "== 安装 cloudflared 服务 =="
if systemctl list-unit-files 2>/dev/null | grep -q '^cloudflared\.service'; then
  echo "  cloudflared.service 已存在，跳过 install（要换 token 就先 cloudflared service uninstall）"
else
  run "$CF" service install "$TOKEN"
fi
run systemctl enable --now cloudflared 2>/dev/null || true
if [ "$DRY_RUN" != "1" ]; then
  systemctl is-active cloudflared || { echo "cloudflared 没起来，看 journalctl -u cloudflared -n 50" >&2; exit 1; }
fi

# ------------------------------------- b. relay 的 --public-url 指向新域名
if [ "$SKIP_RELAY_URL" = "1" ]; then
  echo "== 跳过 relay public-url 改写（--skip-relay-url）=="
else
  echo "== 改写 ${RELAY_SERVICE} 的 --public-url =="
  UNIT="$(systemctl show -p FragmentPath --value "$RELAY_SERVICE" 2>/dev/null || true)"
  if [ -z "$UNIT" ] || [ ! -f "$UNIT" ]; then
    echo "  找不到 ${RELAY_SERVICE} 的 unit 文件（服务名不对？），跳过" >&2
  elif ! grep -q -- '--public-url' "$UNIT"; then
    echo "  unit 里没有 --public-url，跳过（relay 会自己推断地址）" >&2
  else
    CURRENT="$(grep -oE -- '--public-url[= ]+[^ ]+' "$UNIT" | head -1 | awk '{print $2}' | tr -d '"' || true)"
    if [ "$CURRENT" = "$PUBLIC_URL" ]; then
      echo "  已经是 $PUBLIC_URL，不用改"
    else
      echo "  $CURRENT -> $PUBLIC_URL"
      BACKUP="${UNIT}.bak-$(date +%Y%m%d-%H%M%S)"
      run cp -a "$UNIT" "$BACKUP"
      # 只替换第一个 --public-url 的取值，其余行原样保留。
      run sed -i "0,/--public-url[= ][^ ]*/s//--public-url ${PUBLIC_URL}/" "$UNIT"
      run systemctl daemon-reload
      run systemctl restart "$RELAY_SERVICE"
      echo "  备份：$BACKUP"
    fi
  fi
fi

# -------------------------------------------------------- c. 公网探活
if [ "$DRY_RUN" = "1" ]; then
  echo "== [dry-run] 略过公网探活，预计检查 $PUBLIC_URL/m/ 等 =="
  exit 0
fi

echo "== 等待 $PUBLIC_URL 可用（最多 60s）=="
ok=0
for _ in $(seq 1 20); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 "${PUBLIC_URL}/m/" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 3
done
if [ "$ok" != "1" ]; then
  cat >&2 <<'EOF'
  域名还没返回 200。依次查：
    1) Cloudflare 里 Public Hostname 是否指向 https://localhost:443 且勾了 No TLS Verify
    2) curl -sS https://<domain>/cdn-cgi/trace 能看到 colo 说明 DNS/代理通了
    3) journalctl -u cloudflared -n 50
    4) curl -sk https://localhost/m/ 在本机是否 200
EOF
  exit 1
fi

echo "== 探活 =="
asset="$(curl -sS -m 15 "${PUBLIC_URL}/m/" | grep -oE 'assets/mobile-[A-Za-z0-9_-]+\.js' | head -1)"
probe() {
  local path="$1" url
  [ -n "$path" ] || return 0
  url="${PUBLIC_URL}/${path#/}"
  printf '  %-28s %s\n' "/${path#/}" "$(curl -sS -o /dev/null -w '%{http_code}' -m 15 "$url")"
}
probe "/m/"
probe "$asset"
probe "/api/node"
echo
echo "完成。手机打开 ${PUBLIC_URL}/ 登录，或在“添加电脑”里用新的域名令牌。"
echo "证书由 Cloudflare 签发，源站 ${ORIGIN} 保持原样（自带证书也不影响）。"
