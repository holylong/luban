# 用域名访问 relay（并决定要不要隐藏 IP）

> 从零部署中继（目录、systemd、TLS、升级回滚、排错）见 [relay-deploy.md](relay-deploy.md)；本文只讲域名/隧道这条链路。

手机现在是通过 `https://thickness-oxygen-life-resistant.trycloudflare.com/m/` 连到 relay 的。换成域名有两个独立的目标，
先把它们分开，否则容易选错方案：

1. **好记 + 证书受信**——浏览器不再报自签名告警，书签能换域名。
2. **隐藏源站 IP**——别人不知道服务器真实地址。

只有第 1 条的话，域名 A 记录直接指向服务器就够了；但只要这么做，`dig` 一次就能拿到 IP，
证书透明度日志（CT）也会把你的域名和证书公开归档，**第 2 条必然做不到**。要藏 IP，
流量必须先落到别人家（Cloudflare 之类的 CDN/隧道），由它转发给源站，源站不出现在任何
DNS 记录里。

## 免费能拿到域名的途径

| 类型 | 例子 | 能接 Cloudflare（隐藏 IP 的前提） |
| --- | --- | --- |
| 可改 NS 的免费真域名 | DigitalPlat 的 `xxx.us.kg` / `xxx.dpdns.org`、`xxx.eu.org`（人工审核）、`xxx.pp.ua`（短信激活） | ✅ |
| 免费子域名 / 动态 DNS | `duckdns.org`、`dynv6.net`、`freedns.afraid.org`、`is-a.dev`（GitHub PR） | ❌ 不能改 NS，IP 仍然公开 |
| 零注册偷懒款 | `203-0-113-7.nip.io`、`sslip.io` | ❌ 域名里直接写着 IP |

免费顶级域的通病是**没有 SLA**：注册局被滥用后整站停解析的先例不少（us.kg 这类）。
长期用建议买个 `.top`/`.xyz` 促销域名（一年十块钱级别），或者直接放在 Cloudflare 注册商按成本价。

## 三条路线与实测代价

在本机（广州·电信）到服务器（北京阿里云那台机器）实测，2026-11-19：

| 路线 | 隐藏 IP | 冷启动一次请求 | 复用连接后每次请求 | 额外工作 |
| --- | --- | --- | --- | --- |
| 直连 IP（现状） | ❌ | 145 ms | ~50 ms | 无 |
| 域名 + Cloudflare 隧道 | ✅ | 830 ms | ~520 ms | 装 cloudflared，见下方步骤 |
| 域名直连 443 + Let's Encrypt | ❌ | ~145 ms | ~50 ms | 必须 ICP 备案，见文末 |

隧道那 ~460 ms 的额外延迟不是配置问题：`curl https://www.cloudflare.com/cdn-cgi/trace`
显示这台服务器被调度到 `colo=LAX`，也就是「北京源站 → 洛杉矶边缘节点 → 手机所在边缘节点」，
每跳都算钱。聊天类界面因为有 SSE 长连接，交互感比数字看起来好一些，但每次 API 调用
确实多付一次跨洋往返。

结论：**隐藏 IP 一定要付出一个中转跳**，免费的代价就是上面这 460 ms。在意延迟就选
「便宜 VPS 反向代理」（香港/日本机器，RTT 50–80 ms，`nginx` 反代 + 防火墙只放行这台 VPS 的 IP），
或者干脆放弃隐藏 IP。

## 路线 A：Cloudflare 隧道（推荐，0 元、不用备案）

Cloudflare Tunnel 由服务器**主动向外**拨出长连接，公网不开放任何端口，因此：

- 源站 IP 不出现在 DNS 里；
- 不需要 ICP 备案（没有任何入站 HTTP 流量到国内 IP）；
- 证书由 Cloudflare 自动签发，手机不再看到自签名告警。

### 1. 拿域名并托管到 Cloudflare

以 DigitalPlat 为例：注册账号 → 选 `us.kg`/`dpdns.org` → 把 NS 改成 Cloudflare 给的两个
域名服务器 → 在 Cloudflare 里等 zone 变成 Active。`eu.org` 是人工审核，几天到几周不等。

### 2. 在这台服务器装 cloudflared

国内直连 GitHub 很慢（实测几十 KB/s），建议本机下好再 `scp`：

```bash
# 本机
curl -fL -o cloudflared-linux-amd64 \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
scp cloudflared-linux-amd64 <user>@<your-server>:~/apps/bin/cloudflared

# 服务器
chmod +x ~/apps/bin/cloudflared && ~/apps/bin/cloudflared --version   # 2026.11.1
```

### 3. 建隧道、配 Public Hostname

Zero Trust → Networks → Tunnels → Create a tunnel（Cloudflared）→ 复制 token。
在 Public Hostname 里加：

- Subdomain/Domain：`relay.你的域名`
- Service：`https://localhost:443`
- 展开 Additional settings 勾上 **No TLS Verify**（源站是 relay 自签证书，必须勾）

### 4. 一条命令接上

```bash
sudo ./scripts/setup-relay-tunnel.sh --domain relay.你的域名 --token <TUNNEL_TOKEN>
sudo ./scripts/setup-relay-tunnel.sh --domain relay.你的域名 --token <T> --dry-run   # 先看它要做什么
```

脚本做三件事，可重复执行：`cloudflared service install` 装服务；把 `luban-relay` 的
`--public-url` 改成 `https://<域名>`（先 `cp -a` 备份 unit，再 `daemon-reload` + `restart`）；
然后探活 `/m/`、`assets/mobile-*.js`、未授权的 `/api/node`（应 401）。

`--public-url` 必须改，否则 relay 生成的登录链接、节点连接命令里仍然是 IP。

### 5. 验证

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

## 路线 B：域名直连 443 + Let's Encrypt

适合「只想要好记的域名和受信证书，不在乎 IP 公开」的情况（延迟与现状一致）。

两个现实约束：

- 这台机器的 `:80` 已被别的进程占用，`--standalone` 的 HTTP-01 验证跑不了，只能用
  **DNS-01**（acme.sh 的 `dns_cf`/`dns_ali` 插件，或用 Cloudflare 的 DNS API token）。
- 国内服务器的 80/443 上跑未备案域名，阿里云会按备案要求阻断；要么走备案（实名 + 1–3 周），
  要么把域名指向境外机器。这也是现状里统计服务放在 `18080` 端口的原因。

拿到证书后 relay 不需要改代码，只换两个参数：

```bash
sudo systemctl edit --full luban-relay
#   --tls-key /path/fullchain.key  --tls-cert /path/fullchain.pem  --public-url https://你的域名
sudo systemctl daemon-reload && sudo systemctl restart luban-relay
```

此时把 `--tls-key/--tls-cert` 换成 Let's Encrypt 的全链证书，手机就再也不需要「继续访问」了，
`curl -k` 也可以去掉。

## 回滚

- 隧道：`sudo cloudflared service uninstall`；把 `luban-relay` 的 unit 从
  `/etc/systemd/system/luban-relay.service.bak-<时间戳>` 还原后 `daemon-reload` + `restart`。
  原来的 IP 访问路径全程没有被改动，回滚只是把域名那条链路关掉。
- 证书：换回 `tls/key.pem` + `tls/fullchain.pem`（relay 自签那套）即可。

## 内置默认地址（可由配置文件覆盖）

代码里只有一处默认地址：`src/core/service-defaults.ts`

| 用途 | 内置默认 | 配置文件键 | 环境变量 |
| --- | --- | --- | --- |
| 手机远控中继 | `https://thickness-oxygen-life-resistant.trycloudflare.com` | `remote.relay_url` | `LUBAN_RELAY_PUBLIC_URL` |
| 使用统计上报 | `https://submitting-reseller-trustee-fairy.trycloudflare.com/api/report` | `usage_stats.url` | `LUBAN_USAGE_STATS_URL` |

优先级都是 config.json > 环境变量 > 内置默认；所以隧道换域名后，既可以只改这一个常量重新发布，
也可以只在本机 `~/.luban/config.json` 里覆盖而不动代码。Android 端另有
`MainActivity.DEFAULT_SERVER`（首次启动的默认中继，之后以应用内设置的服务器为准）。

## 现状记录（2026-11-19）

- relay 由 systemd 以普通用户运行：`--host 0.0.0.0 --port 443 --public-url https://thickness-oxygen-life-resistant.trycloudflare.com
  --https --tls-key .../tls/key.pem --tls-cert .../tls/fullchain.pem --accounts ~/.config/luban/accounts.json`。
- `cloudflared 2026.11.1` 已放在 `~/apps/bin/cloudflared`（sha256 与本机下载件一致）。
- 该服务器到 Cloudflare 的出口走 `LAX`，隧道方案固定多约 460 ms；要更低延迟得换中转位置。
