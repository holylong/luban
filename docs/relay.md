# 中继（`luban relay`）：部署、公网入口与域名

手机远控需要一台公网可达的机器当中继：手机连中继，各电脑节点从内网拨出去连中继，
中继只转发请求和 SSE，不保存对话。这份文档把「从零到手机能打开」的步骤、目录约定、
systemd 单元、TLS、升级回滚和排错写在一起，最后是公网入口与域名的取舍（§11）。
统计服务是另一个程序，见 [usage-stats.md](usage-stats.md)。

## 0. 它是什么

- 中继**不是一个独立二进制**，而是 `luban` CLI 的子命令：`node dist/cli.js relay …`，
  实现在 `src/web/relay.ts`（客户端拨出在 `src/web/tunnel.ts`）。一次 `npm run build`
  就把两者编译进 `dist/`，没有额外的编译步骤。
- 运行时要求 Node ≥ 20（`package.json` 的 `engines`）。现有线上机器是
  `/usr/local/bin/node` → v22.12.0。
- 一张最小的部署清单：`dist/`、`dist/web-ui/`、`package.json`、`node_modules/`，外加
  一份凭据文件与一个 systemd 单元。**`dist/web-ui/` 不能省**：中继自己托管手机页面
  `/m/`（`src/web/assets.ts` 的 `webRoot()`），缺了它手机打开就是 404。

## 1. 在开发机上打包

```bash
npm run build                     # 产出 dist/（服务端）与 dist/web-ui/（手机页面）
tar -czf luban-relay-<版本>.tar.gz dist package.json package-lock.json
```

依赖没有变化时可以只传 `dist`；依赖变了就把 `node_modules` 一起打进去，或者在服务器上
`npm ci --omit=dev`（服务器要能访问 npm 源）。发布包永远按**整目录替换**处理，不要手动
挑文件，否则 `dist/web-ui/assets/` 里带哈希的文件名会和 `mobile.html` 对不上。

## 2. 服务器目录约定

线上服务器的实际布局（地址、用户名按自己的环境替换），照抄即可：

```
/home/luban/apps/luban/
  dist/                    # 程序（含 dist/web-ui/）
  dist.bak-<版本>-<时间>/   # 上一版，回滚用
  node_modules/
  package.json
  tls/key.pem              # 证书私钥（0600）
  tls/fullchain.pem        # 证书链
/home/luban/.config/luban/
  relay.env                # 令牌与公网地址（0600）
  accounts.json            # 账号/设备库（0600，运行中会写）
```

替换版本：

```bash
cd /home/luban/apps/luban
cp -a dist "dist.bak-$(date +%Y%m%d-%H%M%S)"
tar -xzf luban-relay-<版本>.tar.gz -C .
```

> `accounts.json` 与 `relay.env` 只备份、不要随版本目录一起覆盖；账户库里是注册用户、
> 设备令牌和待派任务。

## 3. 凭据文件 `~/.config/luban/relay.env`

权限必须是 `0600`，systemd 用 `EnvironmentFile=` 读入：

```bash
install -m 600 /dev/null ~/.config/luban/relay.env
cat > ~/.config/luban/relay.env <<'EOF'
LUBAN_RELAY_NODE_TOKEN=<电脑节点连接中继的令牌>
LUBAN_RELAY_ACCESS_TOKEN=<手机/浏览器直达的访问令牌>
LUBAN_RELAY_PUBLIC_URL=https://<对外地址>
LUBAN_RELAY_SMTP_EMAIL=<发注册验证码的邮箱>
LUBAN_RELAY_SMTP_PASSWORD=<邮箱应用专用密码>
LUBAN_RELAY_SMTP_HOST=smtp.163.com
LUBAN_RELAY_SMTP_PORT=465
EOF
```

- 令牌生成：`openssl rand -hex 24`。不写 `NODE_TOKEN` 时进程会自己生成并打印一次，
  但 systemd 下那个值会丢在日志里，建议显式写入。
- `LUBAN_RELAY_PUBLIC_URL` 必须等于**手机真正访问的地址**：中继会把它写进
  `/api/node` 的 `relay_url` 下发给手机。值写错时手机能打开页面却连不上电脑。
- 不配 SMTP 也能用：只是注册验证码发不出去，手机上会提示未配置邮箱。

## 4. TLS 的三种形态

| 形态 | 参数 | 适用 |
| --- | --- | --- |
| 自持证书（现状） | `--https --tls-key tls/key.pem --tls-cert tls/fullchain.pem` | 有域名或 IP 证书；线上用的是 IP 证书 |
| 局域网自签 | 只给 `--https`，可选 `--tls-dir /path` 持久化 | 内网试用；把生成的 `ca.pem` 装进手机，电脑端加 `--relay-ca` |
| 隧道兜底 | 证书照旧，Cloudflare 用 `--no-tls-verify` 连 `https://localhost:443` | 源站没有公网入站端口时 |

IP 证书只能用 ACME 的 IP 标识签发，通常 90 天过期。线上是用一个 oneshot 服务
`luban-renew-cert.service` + `luban-renew-cert.timer`（每天 03:00）续期并在续期后
`systemctl restart luban-relay`；证书文件更新了但没重启，进程还握着旧的，手机就会报证书错误。

## 5. systemd 单元

`/etc/systemd/system/luban-relay.service`（这是线上实际内容，只把地址换成占位符）：

```ini
[Unit]
Description=Luban public phone relay
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=luban
Group=luban
WorkingDirectory=/home/luban/apps/luban
EnvironmentFile=/home/luban/.config/luban/relay.env
ExecStart=/usr/local/bin/node /home/luban/apps/luban/dist/cli.js relay \
  --host 0.0.0.0 --port 443 \
  --public-url https://<对外地址> \
  --https --tls-key /home/luban/apps/luban/tls/key.pem \
  --tls-cert /home/luban/apps/luban/tls/fullchain.pem \
  --accounts /home/luban/.config/luban/accounts.json
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=always
RestartSec=3
KillSignal=SIGINT
StandardOutput=null

[Install]
WantedBy=multi-user.target
```

要点：

- 绑定 443 需要 `CAP_NET_BIND_SERVICE`；不想给能力就换高位端口，让隧道/反代转发过来。
- `KillSignal=SIGINT`：中继在 `SIGINT` 上做优雅关闭（`Restart=always` 也会跟着拉起）。
- `EnvironmentFile` 里的变量可以替代对应命令行参数；两边都写时命令行优先。
- 单元里**不要**把令牌写成字面量，日志和 `systemctl cat` 都会泄露。

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now luban-relay
systemctl status luban-relay --no-pager
```

## 6. 自检

```bash
curl -kfsS https://127.0.0.1/relay/health     # {"ok":true,"service":"luban-relay","version":"<版本>"}
ss -ltnp | grep ':443 '                        # 监听在 0.0.0.0:443
curl -kfsS -o /dev/null -w '%{http_code}\n' https://<对外地址>/m/   # 200
```

中继启动时往 stderr 打印接线信息，第一次部署可以直接前台跑一遍看清楚：

```bash
sudo -u luban env $(grep -v '^#' ~/.config/luban/relay.env | xargs) \
  node dist/cli.js relay --host 127.0.0.1 --port 8788 --public-url http://127.0.0.1:8788
```

会输出 `luban relay http://127.0.0.1:8788`、账户库路径、注册邮件是否可用，以及一行
`节点连接 luban web <项目> --relay … --relay-token …` —— 这就是电脑端该用的参数。

## 7. 电脑端接入与手机

```bash
# 电脑端（内网机器）
luban web /path/to/project --relay https://<对外地址> --relay-token <NODE_TOKEN>
# 账号模式：令牌可以在手机「添加电脑」里生成设备令牌，改用 --relay-device-token
```

手机打开 `https://<对外地址>/m/`：有账号库时先注册/登录（SMTP 发验证码），
之后在「设置 → 账户 → 添加电脑」里拿到设备令牌给电脑端用；没有账号库（`--accounts none`）时用
`LUBAN_RELAY_ACCESS_TOKEN` 直达。

## 8. 公网入口

- **直连 IP + IP 证书**：最简单，端口 443 直接暴露，`--public-url https://<IP>`。
- **Cloudflare 快速隧道**：`cloudflared tunnel --url https://localhost:443 --no-tls-verify`。
  域名每次重启都变，必须同步改 unit 里的 `--public-url` 并重启中继；仓库里的
  `scripts/setup-relay-tunnel.sh` 就是干这个的（改 unit + 备份 + `daemon-reload` + `restart`）。
  线上两个隧道已经是 systemd 单元：`luban-tunnel-relay.service`（→ `localhost:443`）和
  `luban-tunnel-stats.service`（→ `localhost:18080`，属统计服务）。
- **自有域名 + 命名隧道/反代**：长期方案，域名稳定，手机不用跟着换地址。

无论哪种入口，`--public-url` 都要跟它一致，这是最容易忘、也最难排查的一项。

## 9. 升级与回滚

```bash
cd /home/luban/apps/luban
cp -a dist "dist.bak-$(date +%Y%m%d-%H%M%S)"
tar -xzf luban-relay-<新版本>.tar.gz -C .
sudo systemctl restart luban-relay
for i in $(seq 1 30); do
  curl -kfsS https://127.0.0.1/relay/health | grep -q '"version":"<新版本>"' && break
  sleep 1
done
```

健康检查没返回新版本就回滚：`rm -rf dist && cp -a dist.bak-<时间> dist && sudo systemctl restart luban-relay`。
`accounts.json` 不与版本一起回滚。

## 10. 排错

| 现象 | 先看什么 |
| --- | --- |
| 服务起不来 / 反复重启 | `journalctl -u luban-relay -n 80 --no-pager`、`systemctl show -p NRestarts luban-relay` |
| `EACCES` 绑 443 | 单元缺 `AmbientCapabilities=CAP_NET_BIND_SERVICE`，或换了非 root 用户却没给能力 |
| 手机页面 404 | `dist/web-ui/` 没一起部署（`/m/` 由中继自己托管） |
| 手机能打开但连不上电脑 | `--public-url` 与实际入口不一致；或电脑端令牌/`--relay-ca` 不对 |
| Cloudflare `1033` | 隧道进程不在线（地址已换或 cloudflared 挂了），先 `systemctl status luban-tunnel-relay` |
| 证书报错 | 证书是否过期、是否被手机信任；续期后有没有重启中继 |
| 401 | 请求没带 `LUBAN_RELAY_ACCESS_TOKEN`，或账号会话已过期 |
| 注册收不到验证码 | `relay.env` 的 SMTP 项；163 必须用应用专用密码 |
| 账号库读不出来 | `accounts.json` 权限必须是 `0600` 且属主是运行用户 |

## 11. 用域名访问（并决定要不要隐藏 IP）

手机现在是通过 `https://thickness-oxygen-life-resistant.trycloudflare.com/m/` 连到 relay 的。换成域名有两个独立的目标，
先把它们分开，否则容易选错方案：

1. **好记 + 证书受信**——浏览器不再报自签名告警，书签能换域名。
2. **隐藏源站 IP**——别人不知道服务器真实地址。

只有第 1 条的话，域名 A 记录直接指向服务器就够了；但只要这么做，`dig` 一次就能拿到 IP，
证书透明度日志（CT）也会把你的域名和证书公开归档，**第 2 条必然做不到**。要藏 IP，
流量必须先落到别人家（Cloudflare 之类的 CDN/隧道），由它转发给源站，源站不出现在任何
DNS 记录里。

### 免费能拿到域名的途径

| 类型 | 例子 | 能接 Cloudflare（隐藏 IP 的前提） |
| --- | --- | --- |
| 可改 NS 的免费真域名 | DigitalPlat 的 `xxx.us.kg` / `xxx.dpdns.org`、`xxx.eu.org`（人工审核）、`xxx.pp.ua`（短信激活） | ✅ |
| 免费子域名 / 动态 DNS | `duckdns.org`、`dynv6.net`、`freedns.afraid.org`、`is-a.dev`（GitHub PR） | ❌ 不能改 NS，IP 仍然公开 |
| 零注册偷懒款 | `203-0-113-7.nip.io`、`sslip.io` | ❌ 域名里直接写着 IP |

免费顶级域的通病是**没有 SLA**：注册局被滥用后整站停解析的先例不少（us.kg 这类）。
长期用建议买个 `.top`/`.xyz` 促销域名（一年十块钱级别），或者直接放在 Cloudflare 注册商按成本价。

### 三条路线与实测代价

在一台国内客户端到这台服务器实测，2026-11-19：

| 路线 | 隐藏 IP | 冷启动一次请求 | 复用连接后每次请求 | 额外工作 |
| --- | --- | --- | --- | --- |
| 直连 IP（现状） | ❌ | 145 ms | ~50 ms | 无 |
| 域名 + Cloudflare 隧道 | ✅ | 830 ms | ~520 ms | 装 cloudflared，见下方步骤 |
| 域名直连 443 + Let's Encrypt | ❌ | ~145 ms | ~50 ms | 必须 ICP 备案，见文末 |

隧道那 ~460 ms 的额外延迟不是配置问题：`curl https://www.cloudflare.com/cdn-cgi/trace`
显示这台服务器被调度到 `colo=LAX`，也就是「源站 → 洛杉矶边缘节点 → 手机所在边缘节点」，
每跳都算钱。聊天类界面因为有 SSE 长连接，交互感比数字看起来好一些，但每次 API 调用
确实多付一次跨洋往返。

结论：**隐藏 IP 一定要付出一个中转跳**，免费的代价就是上面这 460 ms。在意延迟就选
「便宜 VPS 反向代理」（香港/日本机器，RTT 50–80 ms，`nginx` 反代 + 防火墙只放行这台 VPS 的 IP），
或者干脆放弃隐藏 IP。

### 路线 A：Cloudflare 隧道（推荐，0 元、不用备案）

Cloudflare Tunnel 由服务器**主动向外**拨出长连接，公网不开放任何端口，因此：

- 源站 IP 不出现在 DNS 里；
- 不需要 ICP 备案（没有任何入站 HTTP 流量到国内 IP）；
- 证书由 Cloudflare 自动签发，手机不再看到自签名告警。

#### 1. 拿域名并托管到 Cloudflare

以 DigitalPlat 为例：注册账号 → 选 `us.kg`/`dpdns.org` → 把 NS 改成 Cloudflare 给的两个
域名服务器 → 在 Cloudflare 里等 zone 变成 Active。`eu.org` 是人工审核，几天到几周不等。

#### 2. 在这台服务器装 cloudflared

国内直连 GitHub 很慢（实测几十 KB/s），建议本机下好再 `scp`：

```bash
# 本机
curl -fL -o cloudflared-linux-amd64 \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
scp cloudflared-linux-amd64 <user>@<your-server>:~/apps/bin/cloudflared

# 服务器
chmod +x ~/apps/bin/cloudflared && ~/apps/bin/cloudflared --version   # 2026.11.1
```

#### 3. 建隧道、配 Public Hostname

Zero Trust → Networks → Tunnels → Create a tunnel（Cloudflared）→ 复制 token。
在 Public Hostname 里加：

- Subdomain/Domain：`relay.你的域名`
- Service：`https://localhost:443`
- 展开 Additional settings 勾上 **No TLS Verify**（源站是 relay 自签证书，必须勾）

#### 4. 一条命令接上

```bash
sudo ./scripts/setup-relay-tunnel.sh --domain relay.你的域名 --token <TUNNEL_TOKEN>
sudo ./scripts/setup-relay-tunnel.sh --domain relay.你的域名 --token <T> --dry-run   # 先看它要做什么
```

脚本做三件事，可重复执行：`cloudflared service install` 装服务；把 `luban-relay` 的
`--public-url` 改成 `https://<域名>`（先 `cp -a` 备份 unit，再 `daemon-reload` + `restart`）；
然后探活 `/m/`、`assets/mobile-*.js`、未授权的 `/api/node`（应 401）。

`--public-url` 必须改，否则 relay 生成的登录链接、节点连接命令里仍然是 IP。

#### 5. 验证

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://relay.你的域名/m/        # 200
curl -sSI https://relay.你的域名/m/ | grep -i '^cf-ray'                     # 有 cf-ray 就是在 Cloudflare 后面
dig +short relay.你的域名                                                   # 只有 104.x / 172.6x 的 CF 地址，没有服务器真实 IP
curl -sS -o /dev/null -w '%{http_code}\n' https://relay.你的域名/api/node   # 401
```

WebSocket/SSE 走 Cloudflare 免费版没问题，但要在真机上确认一次聊天流能推消息（免费版对
空闲连接有 100 秒超时，luban 的心跳能自己恢复）。

试用当天不想动 DNS 的话，可以用临时隧道（无需账号、URL 每次重启都变）：

```bash
~/apps/bin/cloudflared tunnel --url https://localhost:443 --no-tls-verify --no-autoupdate
# 日志里会给出 https://<随机词>.trycloudflare.com
```

2026-11-19 已在这台服务器上用临时隧道实测通过：`/m/` 200（2381 B，与直连同字节）、
静态资源 200、未授权 API 401、WS 升级请求能到达 relay（返回 401 而不是 CF 的错误页）。

**临时隧道不能当日常入口**：URL 每次启动都会换，进程一断这个域名就没人接了。这时浏览器
拿到的是 Cloudflare 的 `Error 1033`（Cloudflare Tunnel error，带 Ray ID），意思是「这个域名
对应的隧道当前没有在线连接」——不是 DNS 没配、也不是源站不通。重启 cloudflared 会换一个新
域名，旧域名就固定报 1033。

排查时先看错误页是谁给的：

| 现象 | 含义 |
| --- | --- |
| Cloudflare `Error 1033` / `1033 Cloudflare Tunnel error` | 请求已经到了 Cloudflare，只是没有 connector 接这条隧道：隧道进程没跑，或 URL 已过期 |
| 浏览器「无法连接 / 无法访问此网站」（没有 Ray ID） | 连接没到 Cloudflare：本机网络、DNS 或该域名被拦 |
| 能打开但空白页 | 通道通了，是前端资源或登录态问题：抓 `assets/*.js` 的状态码 |

2026-11-19 的实测：同一域名在国内手机上先报「无法连接」，重启隧道后报 `1033`。
`1033` 这一页是 Cloudflare 自己返回的，说明这个网络**能**到 Cloudflare 边缘，`*.trycloudflare.com`
并没有被整段拦掉；因此不要因为一次「连不上」就断定域名被封，先按上表区分是谁给的错误页。

### 路线 B：域名直连 443 + Let's Encrypt

适合「只想要好记的域名和受信证书，不在乎 IP 公开」的情况（延迟与现状一致）。

两个现实约束：

- 这台机器的 `:80` 已被别的进程占用，`--standalone` 的 HTTP-01 验证跑不了，只能用
  **DNS-01**（acme.sh 的 `dns_cf`/`dns_ali` 插件，或用 Cloudflare 的 DNS API token）。
- 国内服务器的 80/443 上跑未备案域名，云厂商会按备案要求阻断；要么走备案（实名 + 1–3 周），
  要么把域名指向境外机器。这也是现状里统计服务放在 `18080` 端口的原因。

拿到证书后 relay 不需要改代码，只换两个参数：

```bash
sudo systemctl edit --full luban-relay
#   --tls-key /path/fullchain.key  --tls-cert /path/fullchain.pem  --public-url https://你的域名
sudo systemctl daemon-reload && sudo systemctl restart luban-relay
```

此时把 `--tls-key/--tls-cert` 换成 Let's Encrypt 的全链证书，手机就再也不需要「继续访问」了，
`curl -k` 也可以去掉。

### 回滚

- 隧道：`sudo cloudflared service uninstall`；把 `luban-relay` 的 unit 从
  `/etc/systemd/system/luban-relay.service.bak-<时间戳>` 还原后 `daemon-reload` + `restart`。
  原来的 IP 访问路径全程没有被改动，回滚只是把域名那条链路关掉。
- 证书：换回 `tls/key.pem` + `tls/fullchain.pem`（relay 自签那套）即可。

### 内置默认地址（可由配置文件覆盖）

代码里只有一处默认地址：`src/core/service-defaults.ts`

| 用途 | 内置默认 | 配置文件键 | 环境变量 |
| --- | --- | --- | --- |
| 手机远控中继 | `https://thickness-oxygen-life-resistant.trycloudflare.com` | `remote.relay_url` | `LUBAN_RELAY_PUBLIC_URL` |
| 使用统计上报 | `https://submitting-reseller-trustee-fairy.trycloudflare.com/api/report` | `usage_stats.url` | `LUBAN_USAGE_STATS_URL` |

优先级都是 config.json > 环境变量 > 内置默认；所以隧道换域名后，既可以只改这一个常量重新发布，
也可以只在本机 `~/.luban/config.json` 里覆盖而不动代码。Android 端另有
`MainActivity.DEFAULT_SERVER`（首次启动的默认中继，之后以应用内设置的服务器为准）。

### 现状记录（2026-11-19）

- relay 由 systemd 以普通用户运行：`--host 0.0.0.0 --port 443 --public-url https://thickness-oxygen-life-resistant.trycloudflare.com
  --https --tls-key .../tls/key.pem --tls-cert .../tls/fullchain.pem --accounts ~/.config/luban/accounts.json`。
- `cloudflared 2026.11.1` 已放在 `~/apps/bin/cloudflared`（sha256 与本机下载件一致）。
- 该服务器到 Cloudflare 的出口走 `LAX`，隧道方案固定多约 460 ms；要更低延迟得换中转位置。

## 相关文件

| 位置 | 作用 |
| --- | --- |
| `src/web/relay.ts` | 中继服务端（HTTP/HTTPS、`/relay/health`、`/api/node`、`/m/` 托管） |
| `src/web/accounts.ts` | 账号与设备库（`accounts.json`） |
| `src/web/tunnel.ts` | 电脑端拨出隧道（`luban web --remote`） |
| `src/web/relay-login.ts` | 电脑端 `luban login relay` 登录并写令牌 |
| `src/core/service-defaults.ts` | 内置默认中继地址（可用 `remote.relay_url` 覆盖） |
| `scripts/setup-relay-tunnel.sh` | 服务器侧改写 `--public-url` 的脚本 |
