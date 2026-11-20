# 中继服务器部署（`luban relay`）

手机远控需要一台公网可达的机器当中继：手机连中继，各电脑节点从内网拨出去连中继，
中继只转发请求和 SSE，不保存对话。这份文档把「从零到手机能打开」的步骤、目录约定、
systemd 单元、TLS、升级回滚和排错写在一起；隧道/域名那部分细节见
[relay-domain.md](relay-domain.md)，统计服务是另一个程序，见 [usage-stats.md](usage-stats.md)。

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

## 相关文件

| 位置 | 作用 |
| --- | --- |
| `src/web/relay.ts` | 中继服务端（HTTP/HTTPS、`/relay/health`、`/api/node`、`/m/` 托管） |
| `src/web/accounts.ts` | 账号与设备库（`accounts.json`） |
| `src/web/tunnel.ts` | 电脑端拨出隧道（`luban web --remote`） |
| `src/web/relay-login.ts` | 电脑端 `luban login relay` 登录并写令牌 |
| `src/core/service-defaults.ts` | 内置默认中继地址（可用 `remote.relay_url` 覆盖） |
| `scripts/setup-relay-tunnel.sh` | 服务器侧改写 `--public-url` 的脚本 |
| `docs/relay-domain.md` | 域名/隧道方案的取舍与实测记录 |
