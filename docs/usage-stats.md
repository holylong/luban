# 使用统计（安装数 / token）

luban 每隔一段时间向独立统计服务上报一次**增量**：安装数、输入 token、输出 token、运行次数。
服务端单独部署，不参与聊天、不存任何对话内容。

## 上报什么

每次运行结束后，本地账本（`~/.luban/usage-stats.json`）累加本次运行的 token，等间隔到期才上传：

```json
{ "installId": "3f2c…", "version": "2.3.4", "platform": "darwin-arm64",
  "input": 152340, "output": 2870, "runs": 3, "reportedAt": 1794300000000 }
```

- `installId`：安装目录首次使用时随机生成的 UUID，和硬件、账号、邮箱都无关；删掉这个文件就会被当成一个新安装。
- 不含 prompt、回复、文件路径、模型名、IP 之外的任何信息（IP 只用于限流，不落盘）。
- 请求体约 200 字节，默认 6 小时最多一次；空闲且没有待报数据时完全不发请求。
- 全新安装会在第一次启动时发一条 0 token 的心跳，用来把「装了」和「跑了」区分开。

## 配置

`~/.luban/config.json`：

```json
{
  "usage_stats": {
    "enabled": true,
    "url": "http://203.0.113.7:18080/api/report",
    "interval_hours": 6
  }
}
```

环境变量优先级更高：`LUBAN_USAGE_STATS=off` 关闭上报，`LUBAN_USAGE_STATS_URL` 改地址。
关闭后账本仍会本地记录，但不会发出任何请求。

## 服务端（独立仓库）

服务端已经搬出本仓库：**https://github.com/holylong/luban-server**（仓库 `luban-server`，
零依赖 ESM，`node src/index.js` 直接跑，自带 dashboard 与 `node --test` 测试）。
接口契约没变，客户端不需要跟着改：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/report` | 客户端上报，公开（限流 120 次/分钟/IP，请求体 16 KB 上限） |
| GET | `/api/stats` | 汇总 JSON：安装数、7/30 天活跃、输入/输出 token、按天、按版本、按平台 |
| GET | `/`（可加 `?range=7\|30\|90`） | 网页看板（中文，深浅色自适应，60 秒自动刷新） |
| GET | `/health` | 健康检查 |

部署见该仓库 README「部署」：`scripts/package.sh` 打包 → `deploy/install.sh` 校验 sha256、
装 systemd 单元、`enable --now` 并自检 `/health`。线上实例仍是
http://203.0.113.7:18080/ ，数据在 `/var/lib/luban-stats/reports.jsonl`，把新服务的
`LUBAN_STATS_DIR` 指向同目录即可沿用历史数据。

本仓库只保留客户端：`src/core/usage-stats.ts`。

### 连不上统计服务 / relay 会怎样

不影响本地任何功能。上报在每轮结束的 `finally` 里 fire-and-forget，15 秒超时，失败按
2 的幂退避并把增量留在本地账本，恢复后一次性补发；统计服务整个挂掉时 CLI 与 desktop
的行为和没配统计时完全一样。relay 同理：`TunnelClient` 拨不通只是每 1→30 秒重连并在
stderr 打一行 `relay unavailable ...`，`luban web` 的本地端口照常服务，手机连不上不影响
本机使用。两条路径都有回归测试（`src/core/usage-stats.test.ts`、
`src/web/tunnel-offline.test.ts`）。

## 已知取舍

- 客户端里的上报地址不是秘密，别人可以伪造 `installId` 刷数字；这是个人项目的
  采纳度指标，不做防刷。
- 一次运行里被中断的请求，只要 provider 已经返回 usage 就会被计入；完全没返回的
  那一次无法计量。
- 上报失败不重试当天，而是把间隔翻倍（最多 16 倍）后再试，恢复后一次性补发全部
  未确认的增量，所以断网不会丢数据、也不会产生重试风暴。
